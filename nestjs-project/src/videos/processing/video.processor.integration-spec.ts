import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { ChannelsService } from '../../channels/channels.service';
import { MediaTransientError } from '../../media/media.errors';
import { MediaProbeService } from '../../media/media-probe.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import {
  loadMediaFixture,
  MEDIA_FIXTURES,
  type MediaFixtureName,
} from '../../test/media-fixtures.helper';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../../test/storage-test.helper';
import { User } from '../../users/entities/user.entity';
import { WorkerModule } from '../../worker.module';
import { Video, VideoStatus } from '../entities/video.entity';
import { videoSourceKey } from '../videos.constants';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessor, type ProcessVideoJob } from './video.processor';

const TERMINAL = [VideoStatus.READY, VideoStatus.FAILED];

describe('VideoProcessor (integration, real worker in-process)', () => {
  let module: TestingModule;
  let storageCtx: StorageTestContext;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue<ProcessVideoJobData>;
  let processor: VideoProcessor;
  let processSpy: jest.SpyInstance;
  let probeSpy: jest.SpyInstance | undefined;
  let channelId: string;

  beforeAll(async () => {
    storageCtx = await createStorageTestContext();
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
    processor = module.get(VideoProcessor);
    // Spy before init: the BullMQ worker binds to the processor on init.
    processSpy = jest.spyOn(processor, 'process');
    await module.init(); // starts the BullMQ worker on the `bull-test` prefix

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 60_000);

  beforeEach(async () => {
    processSpy.mockClear();
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    channelId = (
      await new ChannelsService(dataSource).createChannel(user.id, user.email)
    ).id;
  });

  afterEach(async () => {
    // Keep `processSpy`: the worker captured it on init, so restoring and
    // re-spying would silently stop counting calls.
    probeSpy?.mockRestore();
    probeSpy = undefined;
    await storageCtx.clearBucket();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await module.close();
    await storageCtx.module.close();
  });

  /** A video in `processing` whose source is the given fixture (or nothing). */
  async function processingVideo(
    fixture: MediaFixtureName | null,
  ): Promise<Video> {
    const id = randomUUID();
    const sourceKey = videoSourceKey(id);
    if (fixture) {
      await storageCtx.storage.putObject(
        sourceKey,
        loadMediaFixture(fixture),
        MEDIA_FIXTURES[fixture].contentType,
      );
    }
    return videoRepository.save({
      id,
      public_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channelId,
      title: 'fixture',
      status: VideoStatus.PROCESSING,
      original_filename: 'fixture.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: '1',
      upload_id: null,
      source_key: sourceKey,
    });
  }

  const enqueue = (videoId: string, backoffDelayMs?: number) =>
    queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      {
        ...PROCESS_VIDEO_JOB_OPTIONS,
        jobId: videoId,
        ...(backoffDelayMs !== undefined && {
          backoff: { type: 'fixed', delay: backoffDelayMs },
        }),
      },
    );

  async function waitForTerminal(
    id: string,
    timeoutMs = 30_000,
  ): Promise<Video> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const video = await videoRepository.findOneByOrFail({ id });
      if (TERMINAL.includes(video.status)) return video;
      if (Date.now() > deadline) {
        throw new Error(
          `Video ${id} still ${video.status} after ${timeoutMs} ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('should take a valid MP4 to ready with metadata and a JPEG thumbnail', async () => {
    const video = await processingVideo('MP4_1080P');

    await enqueue(video.id);
    const done = await waitForTerminal(video.id);

    expect(done).toMatchObject({
      status: VideoStatus.READY,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
      processing_error: null,
    });
    expect(Number(done.duration_seconds)).toBeCloseTo(4, 0);
    expect(done.metadata).toHaveProperty('format');
    expect(done.metadata).toHaveProperty('streams');
    const thumbnail = await storageCtx.client.send(
      new HeadObjectCommand({
        Bucket: storageCtx.config.bucket,
        Key: done.thumbnail_key!,
      }),
    );
    expect(thumbnail.ContentType).toBe('image/jpeg');
    expect(thumbnail.ContentLength).toBeGreaterThan(0);
  }, 40_000);

  it('should fail an audio-only file with NO_VIDEO_STREAM on the first attempt', async () => {
    const video = await processingVideo('AUDIO_ONLY');

    await enqueue(video.id);
    const done = await waitForTerminal(video.id);

    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.processing_error).toMatch(/^NO_VIDEO_STREAM/);
    expect(processSpy).toHaveBeenCalledTimes(1);
  }, 40_000);

  it('should fail with PROCESSING_FAILED after every attempt hit a transient error', async () => {
    const video = await processingVideo(null); // source missing → HTTP 404

    await enqueue(video.id, 50);
    const done = await waitForTerminal(video.id);

    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.processing_error).toMatch(
      /^PROCESSING_FAILED: MEDIA_TRANSIENT/,
    );
    expect(processSpy).toHaveBeenCalledTimes(
      PROCESS_VIDEO_JOB_OPTIONS.attempts,
    );
  }, 40_000);

  it('should end ready when a transient error stops before the last attempt', async () => {
    const video = await processingVideo('MP4_360P');
    probeSpy = jest
      .spyOn(module.get(MediaProbeService), 'probe')
      .mockRejectedValueOnce(
        new MediaTransientError('ffprobe: Connection refused'),
      );

    await enqueue(video.id, 50);
    const done = await waitForTerminal(video.id);

    expect(done.status).toBe(VideoStatus.READY);
    expect(done.processing_error).toBeNull();
    expect(processSpy).toHaveBeenCalledTimes(2);
  }, 40_000);

  it('should leave a ready video untouched when its job is processed again', async () => {
    const video = await processingVideo('MP4_360P');
    await enqueue(video.id);
    const ready = await waitForTerminal(video.id);

    await processor.process({
      id: video.id,
      data: { videoId: video.id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as ProcessVideoJob);

    await expect(
      videoRepository.findOneByOrFail({ id: video.id }),
    ).resolves.toEqual(ready);
  }, 40_000);
});
