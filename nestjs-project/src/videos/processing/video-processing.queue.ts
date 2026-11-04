import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { ProcessingQueueUnavailableError } from './video-processing.errors';

/** Producer of `process-video` jobs. The consumer lives only in the worker. */
@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Publishes the processing job. `jobId = videoId` makes it idempotent: a
   * second call while the job still exists is ignored by BullMQ.
   */
  async enqueue(videoId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ENQUEUE_TIMEOUT_MS} ms`)),
        ENQUEUE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([
        this.queue.add(
          PROCESS_VIDEO_JOB,
          { videoId },
          { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
        ),
        timeout,
      ]);
    } catch (error) {
      throw new ProcessingQueueUnavailableError(videoId, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
