import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENTS } from './storage.constants';
import { StorageService } from './storage.service';

const createS3Client = (
  storage: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: storage.region,
    credentials: {
      accessKeyId: storage.accessKey,
      secretAccessKey: storage.secretKey,
    },
    // MinIO and most S3-compatible storages answer path-style URLs.
    forcePathStyle: true,
    // Default CRC checksums leak into presigned UploadPart URLs and break
    // plain browser PUTs against S3-compatible storages.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

@Module({
  providers: [
    {
      provide: STORAGE_CLIENTS.INTERNAL,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        createS3Client(storage, storage.endpoint),
    },
    {
      provide: STORAGE_CLIENTS.PUBLIC,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        createS3Client(storage, storage.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
