import { execFileSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StorageService } from '../storage/storage.service';

export const MEDIA_FIXTURES = {
  /** 4 s, 1920×1080, H.264 + AAC. */
  MP4_1080P: {
    file: 'mp4-1080p.mp4',
    contentType: 'video/mp4',
    durationSeconds: 4,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1920x1080:rate=25:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
    ],
  },
  /** 2 s, 640×360, H.264 without audio — smaller than the thumbnail cap. */
  MP4_360P: {
    file: 'mp4-360p.mp4',
    contentType: 'video/mp4',
    durationSeconds: 2,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=25:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ],
  },
  /**
   * 4 s, 640×360, lossless H.264 without audio: ~1.9 MB, larger than the
   * 1 MiB `Range` read of the streaming tests.
   */
  MP4_OVER_1MIB: {
    file: 'mp4-over-1mib.mp4',
    contentType: 'video/mp4',
    durationSeconds: 4,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ],
  },
  /** 2 s, 320×240, VP9 without audio. */
  WEBM_NO_AUDIO: {
    file: 'webm-no-audio.webm',
    contentType: 'video/webm',
    durationSeconds: 2,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=2',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '200k',
    ],
  },
  /** 2 s of AAC audio, no video stream. */
  AUDIO_ONLY: {
    file: 'audio-only.m4a',
    contentType: 'audio/mp4',
    durationSeconds: 2,
    args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac'],
  },
  /** 64 KiB of random bytes: not media at all. */
  RANDOM_BYTES: {
    file: 'random.bin',
    contentType: 'video/mp4',
    durationSeconds: 0,
    args: null,
  },
} as const;

export type MediaFixtureName = keyof typeof MEDIA_FIXTURES;

const FIXTURES_DIR = join(tmpdir(), 'streamtube-media-fixtures');
const FIXTURE_URL_TTL_SECONDS = 600;

/** Generates (once per container) and returns the fixture bytes. */
export function loadMediaFixture(name: MediaFixtureName): Buffer {
  const fixture = MEDIA_FIXTURES[name];
  const path = join(FIXTURES_DIR, fixture.file);
  if (!existsSync(path)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    if (fixture.args === null) {
      writeFileSync(path, randomBytes(64 * 1024));
    } else {
      execFileSync('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        ...fixture.args,
        path,
      ]);
    }
  }
  return readFileSync(path);
}

/**
 * Uploads a fixture to the test bucket and returns a presigned GET URL on the
 * internal endpoint — exactly how the worker hands sources to ffprobe/ffmpeg.
 */
export async function uploadMediaFixture(
  storage: StorageService,
  name: MediaFixtureName,
): Promise<{ key: string; url: string }> {
  const fixture = MEDIA_FIXTURES[name];
  const key = `videos/${randomUUID()}/source`;
  await storage.putObject(key, loadMediaFixture(name), fixture.contentType);
  const url = await storage.presignGetObject(key, FIXTURE_URL_TTL_SECONDS, {
    endpoint: 'internal',
  });
  return { key, url };
}

/** Reads codec and dimensions of an image buffer through ffprobe (stdin). */
export function probeImage(image: Buffer): {
  codec: string;
  width: number;
  height: number;
} {
  const output = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-i', 'pipe:0'],
    { input: image },
  );
  const { streams } = JSON.parse(output.toString('utf8')) as {
    streams: { codec_name: string; width: number; height: number }[];
  };
  const [stream] = streams;
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
  };
}
