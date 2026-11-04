/**
 * The processing job could not be published (Redis unreachable or too slow).
 * Callers map it to their own domain error (`QUEUE_UNAVAILABLE`).
 */
export class ProcessingQueueUnavailableError extends Error {
  constructor(
    public readonly videoId: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not enqueue processing job for video ${videoId}`, options);
    this.name = 'ProcessingQueueUnavailableError';
  }
}
