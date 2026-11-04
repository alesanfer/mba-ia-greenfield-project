import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export type ProcessVideoJobData = { videoId: string };

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  // `jobId = videoId`: a finished job left in Redis would make BullMQ ignore
  // any later enqueue of the same video. The outcome lives in the DB
  // (`status` / `processing_error`), so finished jobs are dropped.
  removeOnComplete: true,
  removeOnFail: true,
} as const satisfies JobsOptions;

/**
 * BullMQ waits indefinitely for Redis to become ready, so a producer call
 * against an unreachable Redis would hang the HTTP request. Bound it instead.
 */
export const ENQUEUE_TIMEOUT_MS = 5000;
