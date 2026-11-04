import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NoSuchUpload,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  INVALID_PARTS_ERROR_CODES,
  STORAGE_CLIENTS,
} from './storage.constants';
import { StorageInvalidPartsError } from './storage.errors';
import type {
  ListedPart,
  PresignGetObjectOptions,
  UploadedPart,
} from './storage.types';

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly bucket: string;

  constructor(
    @Inject(STORAGE_CLIENTS.INTERNAL) private readonly internalClient: S3Client,
    @Inject(STORAGE_CLIENTS.PUBLIC) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = storage.bucket;
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for key "${key}"`);
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<ListedPart[]> {
    const parts: ListedPart[] = [];
    let marker: string | undefined;

    do {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber === undefined || !part.ETag) continue;
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size ?? 0,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
          },
        }),
      );
    } catch (error) {
      if (this.isInvalidPartsError(error)) {
        throw new StorageInvalidPartsError(error.name, { cause: error });
      }
      throw error;
    }
  }

  /** Idempotent: an upload that is already gone counts as aborted. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (error instanceof NoSuchUpload) return;
      throw error;
    }
  }

  /** Returns the object size in bytes, or `null` when the object does not exist. */
  async headObject(key: string): Promise<number | null> {
    try {
      const { ContentLength } = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return ContentLength ?? 0;
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async presignGetObject(
    key: string,
    ttlSeconds: number,
    { endpoint, downloadFilename }: PresignGetObjectOptions,
  ): Promise<string> {
    const client =
      endpoint === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadFilename
          ? `attachment; filename="${downloadFilename.replace(/["\\]/g, '_')}"`
          : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  private isInvalidPartsError(error: unknown): error is S3ServiceException {
    return (
      error instanceof S3ServiceException &&
      (INVALID_PARTS_ERROR_CODES as readonly string[]).includes(error.name)
    );
  }
}
