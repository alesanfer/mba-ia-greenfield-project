/**
 * Media failures, split by whether retrying can help. The worker (SI-03.9)
 * maps permanent ones to BullMQ `UnrecoverableError` and lets transient ones
 * consume an attempt.
 */
export abstract class MediaError extends Error {
  abstract readonly permanent: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** The file was read but has no video stream (e.g. audio-only). */
export class NoVideoStreamError extends MediaError {
  readonly permanent = true;

  constructor() {
    super('NO_VIDEO_STREAM: input has no video stream');
  }
}

/** ffprobe read the input but could not parse it as media. */
export class ProbeFailedError extends MediaError {
  readonly permanent = true;

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`PROBE_FAILED: ${detail}`, options);
  }
}

/** The input could not be read (timeout, network, HTTP error). */
export class MediaTransientError extends MediaError {
  readonly permanent = false;

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`MEDIA_TRANSIENT: ${detail}`, options);
  }
}
