import { Injectable } from '@nestjs/common';
import { MediaExecError, runMediaBinary } from './exec-media.util';
import {
  MEDIA_BINARIES,
  THUMBNAIL_MAX_BUFFER_BYTES,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_POSITION_RATIO,
  THUMBNAIL_TIMEOUT_MS,
} from './media.constants';
import { MediaTransientError } from './media.errors';

/** Frame position: 10% of the duration, floored at 0 s for unknown/zero. */
export function thumbnailTimestamp(
  durationSeconds: number | null | undefined,
): number {
  if (!durationSeconds || !Number.isFinite(durationSeconds)) return 0;
  return Math.max(0, durationSeconds * THUMBNAIL_POSITION_RATIO);
}

@Injectable()
export class ThumbnailService {
  /**
   * Extracts one JPEG frame at `atSeconds`, at most 1280px wide keeping the
   * aspect ratio (never upscales). `-ss` before `-i` seeks via HTTP Range;
   * the frame goes to stdout, nothing is written to disk.
   *
   * Runs after a successful probe, so the content is known to be readable
   * media: any failure here is treated as transient (retry).
   */
  async extractThumbnail(inputUrl: string, atSeconds: number): Promise<Buffer> {
    let jpeg: Buffer;
    try {
      jpeg = await runMediaBinary(
        MEDIA_BINARIES.FFMPEG,
        [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          atSeconds.toFixed(3),
          '-i',
          inputUrl,
          '-frames:v',
          '1',
          '-vf',
          `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
          '-f',
          'image2pipe',
          '-vcodec',
          'mjpeg',
          'pipe:1',
        ],
        {
          timeoutMs: THUMBNAIL_TIMEOUT_MS,
          maxBuffer: THUMBNAIL_MAX_BUFFER_BYTES,
        },
      );
    } catch (error) {
      if (!(error instanceof MediaExecError)) throw error;
      throw new MediaTransientError(`ffmpeg: ${error.message}`, {
        cause: error,
      });
    }

    if (jpeg.length === 0) {
      throw new MediaTransientError(
        `ffmpeg produced no frame at ${atSeconds}s`,
      );
    }
    return jpeg;
  }
}
