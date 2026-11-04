import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../videos/processing/video-processing.constants';
import { VideoProcessingModule } from '../videos/processing/video-processing.module';

export interface QueueTestContext {
  module: TestingModule;
  queue: Queue<ProcessVideoJobData>;
  /** Removes every job (any state) of the test queue. */
  clearQueue: () => Promise<void>;
}

/**
 * Builds the `video-processing` queue on the test prefix. `setup-test-env.ts`
 * pins `QUEUE_PREFIX=bull-test`, so the `video-worker` (on `bull`) never sees
 * test jobs and tests never wipe real ones.
 */
export async function createQueueTestContext(): Promise<QueueTestContext> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      QueueModule,
      VideoProcessingModule,
    ],
  }).compile();

  const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  if (config.prefix !== 'bull-test') {
    throw new Error(
      `Refusing to run queue tests against prefix "${config.prefix}"`,
    );
  }
  const queue = module.get<Queue<ProcessVideoJobData>>(
    getQueueToken(VIDEO_PROCESSING_QUEUE),
  );

  return {
    module,
    queue,
    clearQueue: async () => {
      await queue.obliterate({ force: true });
    },
  };
}
