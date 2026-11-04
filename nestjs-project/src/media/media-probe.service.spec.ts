import type { ExecFileException } from 'child_process';
import { MediaExecError } from './exec-media.util';
import { NoVideoStreamError } from './media.errors';
import type { FfprobeOutput, FfprobeStream } from './media.types';
import { parseProbeOutput } from './media-probe.service';
import { thumbnailTimestamp } from './thumbnail.service';

const videoStream = (
  overrides: Partial<FfprobeStream> = {},
): FfprobeStream => ({
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  disposition: { attached_pic: 0 },
  ...overrides,
});

const audioStream = (
  overrides: Partial<FfprobeStream> = {},
): FfprobeStream => ({
  index: 1,
  codec_type: 'audio',
  codec_name: 'aac',
  ...overrides,
});

describe('thumbnailTimestamp', () => {
  it('should take 10% of the duration', () => {
    expect(thumbnailTimestamp(40)).toBe(4);
    expect(thumbnailTimestamp(2.5)).toBeCloseTo(0.25);
  });

  it('should floor at 0 for zero, missing or invalid durations', () => {
    expect(thumbnailTimestamp(0)).toBe(0);
    expect(thumbnailTimestamp(null)).toBe(0);
    expect(thumbnailTimestamp(undefined)).toBe(0);
    expect(thumbnailTimestamp(Number.NaN)).toBe(0);
    expect(thumbnailTimestamp(-5)).toBe(0);
  });
});

describe('parseProbeOutput', () => {
  it('should map format and the first video/audio streams', () => {
    const output: FfprobeOutput = {
      format: { duration: '4.000000', size: '1048576', format_name: 'mov,mp4' },
      streams: [videoStream(), audioStream()],
    };

    expect(parseProbeOutput(output)).toEqual({
      durationSeconds: 4,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      sizeBytes: 1048576,
      raw: { format: output.format, streams: output.streams },
    });
  });

  it('should return a null audioCodec when there is no audio stream', () => {
    const result = parseProbeOutput({
      format: { duration: '2.0' },
      streams: [videoStream({ codec_name: 'vp9', width: 320, height: 240 })],
    });

    expect(result.audioCodec).toBeNull();
    expect(result.videoCodec).toBe('vp9');
  });

  it('should return null duration and size when ffprobe omits them', () => {
    const result = parseProbeOutput({
      format: { duration: 'N/A' },
      streams: [videoStream()],
    });

    expect(result.durationSeconds).toBeNull();
    expect(result.sizeBytes).toBeNull();
  });

  it('should throw NoVideoStreamError for audio-only input', () => {
    expect(() =>
      parseProbeOutput({ format: {}, streams: [audioStream()] }),
    ).toThrow(NoVideoStreamError);
  });

  it('should ignore cover art (attached_pic) as a video stream', () => {
    expect(() =>
      parseProbeOutput({
        format: {},
        streams: [
          audioStream({ index: 0 }),
          videoStream({
            index: 1,
            codec_name: 'mjpeg',
            disposition: { attached_pic: 1 },
          }),
        ],
      }),
    ).toThrow(NoVideoStreamError);
  });

  it('should throw NoVideoStreamError when streams are missing', () => {
    expect(() => parseProbeOutput({ format: {} })).toThrow(NoVideoStreamError);
  });
});

describe('MediaExecError.transient', () => {
  const execError = (
    overrides: Partial<ExecFileException> = {},
  ): ExecFileException =>
    Object.assign(new Error('Command failed'), { code: 1, ...overrides });

  it('should be permanent for invalid content (non-zero exit)', () => {
    const error = new MediaExecError(
      execError(),
      'random.bin: Invalid data found when processing input\n',
    );

    expect(error.transient).toBe(false);
    expect(error.message).toBe(
      'random.bin: Invalid data found when processing input',
    );
  });

  it.each([
    'http://storage:9999/x: Connection refused',
    'Failed to resolve hostname nohost.invalid: Name or service not known',
    'http://storage:9000/b/k: Server returned 403 Forbidden (access denied)',
    'http://storage:9000/b/k: Server returned 503 Service Unavailable',
    'http://nohost.invalid/x: Input/output error',
  ])('should be transient when the input cannot be read: %s', (stderr) => {
    expect(new MediaExecError(execError(), stderr).transient).toBe(true);
  });

  it('should be transient when killed by the timeout', () => {
    const error = new MediaExecError(
      execError({ killed: true, signal: 'SIGKILL', code: null }),
      '',
    );

    expect(error.transient).toBe(true);
  });

  it('should be transient when the binary could not run (ENOENT)', () => {
    const error = new MediaExecError(execError({ code: 'ENOENT' }), '');

    expect(error.transient).toBe(true);
  });
});
