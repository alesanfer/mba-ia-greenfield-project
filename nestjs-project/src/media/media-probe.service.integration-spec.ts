import { Test, type TestingModule } from '@nestjs/testing';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../test/storage-test.helper';
import {
  MEDIA_FIXTURES,
  uploadMediaFixture,
} from '../test/media-fixtures.helper';
import {
  MediaTransientError,
  NoVideoStreamError,
  ProbeFailedError,
} from './media.errors';
import { MediaModule } from './media.module';
import { MediaProbeService } from './media-probe.service';

describe('MediaProbeService (integration)', () => {
  let storageCtx: StorageTestContext;
  let module: TestingModule;
  let probeService: MediaProbeService;

  beforeAll(async () => {
    storageCtx = await createStorageTestContext();
    module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    probeService = module.get(MediaProbeService);
  }, 60_000);

  afterAll(async () => {
    await storageCtx.clearBucket();
    await storageCtx.module.close();
    await module.close();
  });

  it('should extract duration, dimensions and codecs of an H.264/AAC MP4 over HTTP', async () => {
    const { url } = await uploadMediaFixture(storageCtx.storage, 'MP4_1080P');

    const result = await probeService.probe(url);

    expect(result.durationSeconds).toBeCloseTo(
      MEDIA_FIXTURES.MP4_1080P.durationSeconds,
      0,
    );
    expect(result).toMatchObject({
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.raw.streams).toHaveLength(2);
  }, 30_000);

  it('should return a null audioCodec for a WebM without audio', async () => {
    const { url } = await uploadMediaFixture(
      storageCtx.storage,
      'WEBM_NO_AUDIO',
    );

    const result = await probeService.probe(url);

    expect(result.videoCodec).toBe('vp9');
    expect(result.audioCodec).toBeNull();
  }, 30_000);

  it('should reject an audio-only file with NoVideoStreamError', async () => {
    const { url } = await uploadMediaFixture(storageCtx.storage, 'AUDIO_ONLY');

    await expect(probeService.probe(url)).rejects.toBeInstanceOf(
      NoVideoStreamError,
    );
  }, 30_000);

  it('should reject random bytes with ProbeFailedError', async () => {
    const { url } = await uploadMediaFixture(
      storageCtx.storage,
      'RANDOM_BYTES',
    );

    await expect(probeService.probe(url)).rejects.toBeInstanceOf(
      ProbeFailedError,
    );
  }, 30_000);

  it('should classify an unreadable URL as MediaTransientError', async () => {
    const missingUrl = await storageCtx.storage.presignGetObject(
      'videos/does-not-exist/source',
      60,
      { endpoint: 'internal' },
    );

    await expect(probeService.probe(missingUrl)).rejects.toBeInstanceOf(
      MediaTransientError,
    );
    await expect(
      probeService.probe('http://storage:9999/unreachable'),
    ).rejects.toBeInstanceOf(MediaTransientError);
  }, 30_000);
});
