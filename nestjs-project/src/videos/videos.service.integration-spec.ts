import {
  ListMultipartUploadsCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../test/storage-test.helper';
import { User } from '../users/entities/user.entity';
import {
  createQueueTestContext,
  type QueueTestContext,
} from '../test/queue-test.helper';
import { QueueUnavailableException } from '../common/exceptions/domain.exception';
import { execFileSync } from 'child_process';
import { Video, VideoStatus } from './entities/video.entity';
import { videoSourceKey, videoThumbnailKey } from './videos.constants';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './processing/video-processing.constants';
import { VideoProcessingModule } from './processing/video-processing.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** VideosService wired to the real DB, storage and queue (env-driven). */
const buildVideosModule = (): Promise<TestingModule> =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
      TypeOrmModule.forFeature([Video]),
      ChannelsModule,
      StorageModule,
      QueueModule,
      VideoProcessingModule,
    ],
    providers: [VideosService],
  }).compile();

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let storageCtx: StorageTestContext;
  let queueCtx: QueueTestContext;
  let dataSource: DataSource;
  let videosService: VideosService;
  let videoRepository: Repository<Video>;
  let user: User;
  let channel: Channel;

  beforeAll(async () => {
    storageCtx = await createStorageTestContext();
    queueCtx = await createQueueTestContext();
    module = await buildVideosModule();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    videoRepository = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queueCtx.clearQueue();
    user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    channel = await module
      .get(ChannelsService)
      .createChannel(user.id, user.email);
  });

  afterEach(async () => {
    await storageCtx.clearBucket();
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await queueCtx.clearQueue();
    await module.close();
    await queueCtx.module.close();
    await storageCtx.module.close();
  });

  it('should persist the draft with its upload id and source key in the user channel', async () => {
    const result = await videosService.createDraft(user.id, {
      filename: 'aula.mp4',
      mime_type: 'video/mp4',
      size_bytes: 262_144_000,
    });

    const persisted = await videoRepository.findOneByOrFail({ id: result.id });
    expect(persisted).toMatchObject({
      public_id: result.public_id,
      channel_id: channel.id,
      title: 'aula',
      status: VideoStatus.DRAFT,
      original_filename: 'aula.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: '262144000',
      source_key: `videos/${result.id}/source`,
    });
    expect(persisted.upload_id).toEqual(expect.any(String));

    // The multipart upload really exists in the storage.
    const parts = await storageCtx.client.send(
      new ListPartsCommand({
        Bucket: storageCtx.config.bucket,
        Key: persisted.source_key,
        UploadId: persisted.upload_id!,
      }),
    );
    expect(parts.UploadId).toBe(persisted.upload_id);
  });

  it('should return part URLs that accept a direct PUT to the storage', async () => {
    const result = await videosService.createDraft(user.id, {
      filename: 'clip.webm',
      mime_type: 'video/webm',
      size_bytes: 2048,
    });
    expect(result.upload.part_count).toBe(1);

    const res = await fetch(result.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(2048)),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('should abort the multipart upload when the insert fails', async () => {
    jest
      .spyOn(videoRepository, 'save')
      .mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      videosService.createDraft(user.id, {
        filename: 'x.mp4',
        mime_type: 'video/mp4',
        size_bytes: 10,
      }),
    ).rejects.toThrow('insert failed');

    await expect(videoRepository.count()).resolves.toBe(0);
    const { Uploads } = await storageCtx.client.send(
      new ListMultipartUploadsCommand({ Bucket: storageCtx.config.bucket }),
    );
    expect(Uploads ?? []).toHaveLength(0);
  });

  describe('upload session', () => {
    const THREE_PARTS = 2 * 104_857_600 + 1024;

    const putPart = (url: string, size = 1024): Promise<Response> =>
      fetch(url, { method: 'PUT', body: new Uint8Array(randomBytes(size)) });

    it('should list the received part and return URLs only for the 2 missing ones', async () => {
      const draft = await videosService.createDraft(user.id, {
        filename: 'long.mp4',
        mime_type: 'video/mp4',
        size_bytes: THREE_PARTS,
      });
      const sent = await putPart(draft.upload.parts[0].url);
      expect(sent.status).toBe(200);

      const status = await videosService.getUploadStatus(
        user.id,
        draft.public_id,
      );

      expect(status.part_count).toBe(3);
      expect(status.uploaded_parts).toEqual([
        { part_number: 1, etag: sent.headers.get('etag'), size: 1024 },
      ]);
      expect(status.parts.map((p) => p.part_number)).toEqual([2, 3]);
      const resent = await putPart(status.parts[0].url);
      expect(resent.status).toBe(200);
    });

    it('should delete the draft and invalidate the UploadId on cancel', async () => {
      const draft = await videosService.createDraft(user.id, {
        filename: 'cancel.mp4',
        mime_type: 'video/mp4',
        size_bytes: THREE_PARTS,
      });
      await putPart(draft.upload.parts[0].url);

      await videosService.cancelUpload(user.id, draft.public_id);

      await expect(videoRepository.countBy({ id: draft.id })).resolves.toBe(0);
      const late = await putPart(draft.upload.parts[1].url);
      expect(late.status).toBeGreaterThanOrEqual(400);
      await expect(
        storageCtx.storage.headObject(`videos/${draft.id}/source`),
      ).resolves.toBeNull();
    });

    it('should remove an already assembled object when the draft has no upload_id', async () => {
      const draft = await videosService.createDraft(user.id, {
        filename: 'assembled.mp4',
        mime_type: 'video/mp4',
        size_bytes: 16,
      });
      const key = `videos/${draft.id}/source`;
      await storageCtx.storage.putObject(key, randomBytes(16), 'video/mp4');
      await videoRepository.update({ id: draft.id }, { upload_id: null });

      await videosService.cancelUpload(user.id, draft.public_id);

      await expect(storageCtx.storage.headObject(key)).resolves.toBeNull();
      await expect(videoRepository.countBy({ id: draft.id })).resolves.toBe(0);
    });
  });

  describe('getOwnedVideo', () => {
    it('should return a thumbnail_url that serves the JPEG straight from the storage', async () => {
      const draft = await videosService.createDraft(user.id, {
        filename: 'pronto.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      });
      const thumbnailKey = videoThumbnailKey(draft.id);
      // Stand-in for the worker output: a real 64×64 JPEG.
      const jpeg = execFileSync('ffmpeg', [
        ...['-nostdin', '-v', 'error', '-f', 'lavfi'],
        ...['-i', 'color=c=red:s=64x64', '-frames:v', '1'],
        ...['-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
      ]);
      await storageCtx.storage.putObject(thumbnailKey, jpeg, 'image/jpeg');
      await videoRepository.update(
        { id: draft.id },
        {
          status: VideoStatus.READY,
          upload_id: null,
          size_bytes: '1024',
          duration_seconds: '2.000',
          width: 640,
          height: 360,
          video_codec: 'h264',
          thumbnail_key: thumbnailKey,
        },
      );

      const video = await videosService.getOwnedVideo(user.id, draft.public_id);

      expect(video).toMatchObject({
        status: VideoStatus.READY,
        size_bytes: 1024,
        duration_seconds: 2,
        width: 640,
        height: 360,
      });
      const res = await fetch(video.thumbnail_url!);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });
  });

  describe('stream and download URLs', () => {
    const SIZE = 2 * 1048576;
    const ONE_MIB = 1048576;
    let publicId: string;
    let source: Buffer;

    beforeEach(async () => {
      const draft = await videosService.createDraft(user.id, {
        filename: 'minha-aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: SIZE,
      });
      source = randomBytes(SIZE);
      await storageCtx.storage.abortMultipartUpload(
        videoSourceKey(draft.id),
        (await videoRepository.findOneByOrFail({ id: draft.id })).upload_id!,
      );
      await storageCtx.storage.putObject(
        videoSourceKey(draft.id),
        source,
        'video/mp4',
      );
      await videoRepository.update(
        { id: draft.id },
        {
          status: VideoStatus.READY,
          upload_id: null,
          size_bytes: String(SIZE),
        },
      );
      publicId = draft.public_id;
    });

    it('should return a stream URL whose storage answers Range with 206', async () => {
      const { url } = await videosService.getStreamUrl(user.id, publicId);

      const res = await fetch(url, {
        headers: { Range: `bytes=0-${ONE_MIB - 1}` },
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(
        `bytes 0-${ONE_MIB - 1}/${SIZE}`,
      );
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(source.subarray(0, ONE_MIB))).toBe(true);
    });

    it('should return a download URL with the original file name as attachment', async () => {
      const { url } = await videosService.getDownloadUrl(user.id, publicId);

      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="minha-aula.mp4"',
      );
      expect(Buffer.from(await res.arrayBuffer()).length).toBe(SIZE);
    });
  });

  describe('completeUpload', () => {
    const SIZE = 1024;

    /** Creates a 1-part draft and PUTs it to the storage; returns the part. */
    const uploadedDraft = async () => {
      const draft = await videosService.createDraft(user.id, {
        filename: 'done.mp4',
        mime_type: 'video/mp4',
        size_bytes: SIZE,
      });
      const put = await fetch(draft.upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(SIZE)),
      });
      const parts = [{ part_number: 1, etag: put.headers.get('etag')! }];
      return { draft, parts };
    };

    it('should assemble the object, move to processing and leave the job in the queue', async () => {
      const { draft, parts } = await uploadedDraft();

      const result = await videosService.completeUpload(
        user.id,
        draft.public_id,
        { parts },
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        upload_id: null,
        size_bytes: String(SIZE),
      });
      await expect(
        storageCtx.storage.headObject(`videos/${draft.id}/source`),
      ).resolves.toBe(SIZE);
      const job = await queueCtx.queue.getJob(draft.id);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId: draft.id });
    });

    describe('with Redis unreachable', () => {
      const ORIGINAL_PORT = process.env.REDIS_PORT;
      let unreachableModule: TestingModule;
      let consoleError: jest.SpyInstance;

      beforeAll(async () => {
        // BullMQ logs the expected ECONNREFUSED before a listener can attach.
        consoleError = jest
          .spyOn(console, 'error')
          .mockImplementation(() => undefined);
        process.env.REDIS_PORT = '6390'; // nothing listens there
        unreachableModule = await buildVideosModule();
        process.env.REDIS_PORT = ORIGINAL_PORT;
        unreachableModule
          .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
          .on('error', () => undefined); // expected connection errors
      });

      afterAll(async () => {
        await unreachableModule.close();
        consoleError.mockRestore();
      });

      it('should answer QueueUnavailableException, revert to draft and complete on retry', async () => {
        const { draft, parts } = await uploadedDraft();
        const offline = unreachableModule.get(VideosService);

        await expect(
          offline.completeUpload(user.id, draft.public_id, { parts }),
        ).rejects.toBeInstanceOf(QueueUnavailableException);
        await expect(
          videoRepository.findOneByOrFail({ id: draft.id }),
        ).resolves.toMatchObject({
          status: VideoStatus.DRAFT,
          upload_id: null,
        });

        const retried = await videosService.completeUpload(
          user.id,
          draft.public_id,
          { parts },
        );

        expect(retried.status).toBe(VideoStatus.PROCESSING);
        await expect(queueCtx.queue.getJob(draft.id)).resolves.toBeDefined();
      }, 20_000);
    });
  });
});
