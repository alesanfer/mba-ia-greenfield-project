import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../test/storage-test.helper';
import { StorageInvalidPartsError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import type { UploadedPart } from './storage.types';

const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 minimum for every part but the last
const TTL_SECONDS = 300;

const newKey = (): string => `videos/${randomUUID()}/source`;

describe('StorageService (integration)', () => {
  let ctx: StorageTestContext;
  let storage: StorageService;

  beforeAll(async () => {
    ctx = await createStorageTestContext();
    storage = ctx.storage;
  });

  afterEach(async () => {
    await ctx.clearBucket();
  });

  afterAll(async () => {
    await ctx.module.close();
  });

  /** PUTs a part straight to the presigned URL, exactly like a browser would. */
  const uploadPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<UploadedPart> => {
    const url = await storage.presignUploadPart(
      key,
      uploadId,
      partNumber,
      TTL_SECONDS,
    );
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    return { partNumber, etag: etag! };
  };

  const putObject = async (
    size: number,
  ): Promise<{ key: string; body: Buffer }> => {
    const key = newKey();
    const body = randomBytes(size);
    await storage.putObject(key, body, 'video/mp4');
    return { key, body };
  };

  describe('multipart upload', () => {
    it('should accept parts PUT on presigned URLs without checksum headers', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const url = await storage.presignUploadPart(
        key,
        uploadId,
        1,
        TTL_SECONDS,
      );
      expect(url).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum-algorithm/i);

      const part = await uploadPart(key, uploadId, 1, randomBytes(1024));
      expect(part.etag).toMatch(/^"[0-9a-f-]+"$/);
    });

    it('should list uploaded parts with their ETag and size', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const first = await uploadPart(
        key,
        uploadId,
        1,
        randomBytes(MIN_PART_SIZE),
      );
      const second = await uploadPart(key, uploadId, 2, randomBytes(2048));

      const parts = await storage.listParts(key, uploadId);

      expect(parts).toEqual([
        { ...first, size: MIN_PART_SIZE },
        { ...second, size: 2048 },
      ]);
    });

    it('should complete the upload into an object whose size is the sum of the parts', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const parts = [
        await uploadPart(key, uploadId, 1, randomBytes(MIN_PART_SIZE)),
        await uploadPart(key, uploadId, 2, randomBytes(4096)),
      ];

      await storage.completeMultipartUpload(key, uploadId, parts);

      await expect(storage.headObject(key)).resolves.toBe(MIN_PART_SIZE + 4096);
    });

    it('should throw StorageInvalidPartsError and create no object when an ETag diverges', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await uploadPart(key, uploadId, 1, randomBytes(1024));

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(StorageInvalidPartsError);
      await expect(storage.headObject(key)).resolves.toBeNull();
    });

    it('should treat aborting an already aborted upload as success', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });

    it('should invalidate the upload on abort', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const part = await uploadPart(key, uploadId, 1, randomBytes(1024));

      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.completeMultipartUpload(key, uploadId, [part]),
      ).rejects.toBeInstanceOf(StorageInvalidPartsError);
      await expect(storage.headObject(key)).resolves.toBeNull();
    });
  });

  describe('objects and reads', () => {
    it('should return null from headObject for a missing key', async () => {
      await expect(storage.headObject(newKey())).resolves.toBeNull();
    });

    it('should remove an object on deleteObject', async () => {
      const { key } = await putObject(16);

      await storage.deleteObject(key);

      await expect(storage.headObject(key)).resolves.toBeNull();
    });

    it('should answer 206 with the requested bytes for a Range GET on the presigned URL', async () => {
      const { key, body } = await putObject(4096);
      const url = await storage.presignGetObject(key, TTL_SECONDS, {
        endpoint: 'public',
      });

      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

      expect(res.status).toBe(206);
      const chunk = Buffer.from(await res.arrayBuffer());
      expect(chunk.length).toBe(1024);
      expect(chunk.equals(body.subarray(0, 1024))).toBe(true);
    });

    it('should answer with Content-Disposition attachment when downloadFilename is set', async () => {
      const { key } = await putObject(64);
      const url = await storage.presignGetObject(key, TTL_SECONDS, {
        endpoint: 'public',
        downloadFilename: 'my video.mp4',
      });

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="my video.mp4"',
      );
    });

    it('should deny anonymous (unsigned) access to bucket objects', async () => {
      const { key } = await putObject(64);

      const res = await fetch(
        `${ctx.config.endpoint}/${ctx.config.bucket}/${key}`,
      );

      expect(res.status).toBe(403);
    });
  });

  describe('signing endpoints', () => {
    const PUBLIC_ENDPOINT = 'http://public.streamtube.test:9000';
    let originalPublicEndpoint: string | undefined;

    beforeAll(() => {
      originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    });

    afterAll(() => {
      process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    });

    it('should sign public URLs with S3_PUBLIC_ENDPOINT and internal URLs with S3_ENDPOINT', async () => {
      process.env.S3_PUBLIC_ENDPOINT = PUBLIC_ENDPOINT;
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      }).compile();
      const service = module.get(StorageService);
      const key = newKey();

      const publicUrl = new URL(
        await service.presignGetObject(key, TTL_SECONDS, {
          endpoint: 'public',
        }),
      );
      const internalUrl = new URL(
        await service.presignGetObject(key, TTL_SECONDS, {
          endpoint: 'internal',
        }),
      );
      const uploadUrl = new URL(
        await service.presignUploadPart(key, 'upload-id', 1, TTL_SECONDS),
      );
      await module.close();

      expect(publicUrl.origin).toBe(PUBLIC_ENDPOINT);
      expect(uploadUrl.origin).toBe(PUBLIC_ENDPOINT);
      expect(internalUrl.origin).toBe(new URL(ctx.config.endpoint).origin);
      expect(publicUrl.pathname).toBe(`/${ctx.config.bucket}/${key}`);
      expect(publicUrl.searchParams.get('X-Amz-Expires')).toBe(
        String(TTL_SECONDS),
      );
    });
  });
});
