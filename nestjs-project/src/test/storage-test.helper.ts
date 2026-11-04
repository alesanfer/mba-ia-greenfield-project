import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENTS } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

export interface StorageTestContext {
  module: TestingModule;
  storage: StorageService;
  /** Internal S3 client, for assertions and cleanup outside StorageService. */
  client: S3Client;
  config: ConfigType<typeof storageConfig>;
  /** Removes every object and aborts every pending multipart upload of the test bucket. */
  clearBucket: () => Promise<void>;
}

/**
 * Builds a StorageModule bound to the env config. `setup-test-env.ts` pins
 * `S3_BUCKET` to `streamtube-videos-test`, so tests never touch the dev bucket.
 */
export async function createStorageTestContext(): Promise<StorageTestContext> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  if (config.bucket !== 'streamtube-videos-test') {
    throw new Error(
      `Refusing to run storage tests against bucket "${config.bucket}"`,
    );
  }
  const client = module.get<S3Client>(STORAGE_CLIENTS.INTERNAL);

  const clearBucket = async (): Promise<void> => {
    const Bucket = config.bucket;

    const uploads = await client.send(
      new ListMultipartUploadsCommand({ Bucket }),
    );
    for (const upload of uploads.Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }

    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket, ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: object.Key }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  };

  return {
    module,
    storage: module.get(StorageService),
    client,
    config,
    clearBucket,
  };
}
