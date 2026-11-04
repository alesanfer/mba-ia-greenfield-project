import { Injectable } from '@nestjs/common';
import { MediaExecError, runMediaBinary } from './exec-media.util';
import {
  MEDIA_BINARIES,
  PROBE_MAX_BUFFER_BYTES,
  PROBE_TIMEOUT_MS,
} from './media.constants';
import {
  MediaTransientError,
  NoVideoStreamError,
  ProbeFailedError,
} from './media.errors';
import type { FfprobeOutput, FfprobeStream, ProbeResult } from './media.types';

const toFiniteNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Cover art in audio files is reported as a video stream; it is not video. */
const isRealVideoStream = (stream: FfprobeStream): boolean =>
  stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1;

/** Maps ffprobe JSON to the persisted metadata shape. */
export function parseProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find(isRealVideoStream);
  if (!video?.codec_name || !video.width || !video.height) {
    throw new NoVideoStreamError();
  }
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  return {
    durationSeconds: toFiniteNumber(output.format?.duration),
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    sizeBytes: toFiniteNumber(output.format?.size),
    raw: { format: output.format, streams },
  };
}

@Injectable()
export class MediaProbeService {
  /** Probes a media file over HTTP (Range reads; never downloads it whole). */
  async probe(inputUrl: string): Promise<ProbeResult> {
    let stdout: Buffer;
    try {
      stdout = await runMediaBinary(
        MEDIA_BINARIES.FFPROBE,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputUrl,
        ],
        { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER_BYTES },
      );
    } catch (error) {
      if (!(error instanceof MediaExecError)) throw error;
      if (error.transient) {
        throw new MediaTransientError(`ffprobe: ${error.message}`, {
          cause: error,
        });
      }
      throw new ProbeFailedError(error.message, { cause: error });
    }

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
    } catch (error) {
      throw new ProbeFailedError('ffprobe returned invalid JSON', {
        cause: error,
      });
    }
    return parseProbeOutput(output);
  }
}
