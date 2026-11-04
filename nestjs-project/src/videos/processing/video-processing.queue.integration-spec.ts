import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { QueueModule } from '../../queue/queue.module';
import {
  createQueueTestContext,
  type QueueTestContext,
} from '../../test/queue-test.helper';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { ProcessingQueueUnavailableError } from './video-processing.errors';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingQueue } from './video-processing.queue';

describe('VideoProcessingQueue (integration)', () => {
  let ctx: QueueTestContext;
  let producer: VideoProcessingQueue;

  beforeAll(async () => {
    ctx = await createQueueTestContext();
    producer = ctx.module.get(VideoProcessingQueue);
  });

  beforeEach(async () => {
    await ctx.clearQueue();
  });

  afterAll(async () => {
    await ctx.clearQueue();
    await ctx.module.close();
  });

  it('should enqueue a process-video job identified by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const jobs = await ctx.queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job.id).toBe(videoId);
    expect(job.name).toBe(PROCESS_VIDEO_JOB);
    expect(job.data).toEqual({ videoId });
  });

  it('should configure 3 attempts with exponential backoff', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await ctx.queue.getJob(videoId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    await expect(ctx.queue.getJobCounts('waiting')).resolves.toEqual({
      waiting: 1,
    });
  });

  describe('with Redis unreachable', () => {
    const ORIGINAL_PORT = process.env.REDIS_PORT;

    afterEach(() => {
      process.env.REDIS_PORT = ORIGINAL_PORT;
    });

    it(
      'should reject with ProcessingQueueUnavailableError instead of hanging',
      async () => {
        // Nothing listens on this port in the `redis` container.
        process.env.REDIS_PORT = '6390';
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
            QueueModule,
            VideoProcessingModule,
          ],
        }).compile();
        // Connection errors are expected here; keep them out of the output.
        const onConnectionError = jest.fn();
        module
          .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
          .on('error', onConnectionError);
        const unreachable = module.get(VideoProcessingQueue);
        const videoId = randomUUID();

        const startedAt = Date.now();
        const error: unknown = await unreachable.enqueue(videoId).then(
          () => null,
          (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(ProcessingQueueUnavailableError);
        expect((error as ProcessingQueueUnavailableError).videoId).toBe(
          videoId,
        );
        expect(Date.now() - startedAt).toBeLessThan(ENQUEUE_TIMEOUT_MS + 1000);
        expect(onConnectionError).toHaveBeenCalled();
        await module.close();
      },
      ENQUEUE_TIMEOUT_MS + 10_000,
    );
  });
});
