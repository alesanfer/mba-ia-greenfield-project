export const MEDIA_BINARIES = {
  FFPROBE: 'ffprobe',
  FFMPEG: 'ffmpeg',
} as const;

/** Upper bound for a single ffprobe run over HTTP (seeks via Range). */
export const PROBE_TIMEOUT_MS = 60_000;
/** Upper bound for extracting one frame over HTTP. */
export const THUMBNAIL_TIMEOUT_MS = 120_000;

/** ffprobe JSON can be large for files with many streams/chapters. */
export const PROBE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** A 1280px-wide JPEG frame stays well below this. */
export const THUMBNAIL_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export const THUMBNAIL_MAX_WIDTH = 1280;
/** The thumbnail frame is taken at this fraction of the duration. */
export const THUMBNAIL_POSITION_RATIO = 0.1;

/**
 * ffprobe/ffmpeg stderr fragments that mean the input could not be *read*
 * (network, DNS, HTTP status — e.g. an expired presigned URL), as opposed to
 * the content being invalid. These are worth a retry.
 */
export const TRANSIENT_STDERR_PATTERNS = [
  /Connection (refused|timed out|reset)/i,
  /Failed to resolve hostname/i,
  /Network is unreachable/i,
  /Server returned [45]\d\d/i,
  /Input\/output error/i,
  /Operation timed out/i,
] as const;
