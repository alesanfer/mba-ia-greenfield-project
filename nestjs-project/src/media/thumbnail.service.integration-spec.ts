import { Test, type TestingModule } from '@nestjs/testing';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../test/storage-test.helper';
import { probeImage, uploadMediaFixture } from '../test/media-fixtures.helper';
import { MediaTransientError } from './media.errors';
import { MediaModule } from './media.module';
import { ThumbnailService, thumbnailTimestamp } from './thumbnail.service';

const JPEG_SOI = Buffer.from([0xff, 0xd8]);

describe('ThumbnailService (integration)', () => {
  let storageCtx: StorageTestContext;
  let module: TestingModule;
  let thumbnails: ThumbnailService;

  beforeAll(async () => {
    storageCtx = await createStorageTestContext();
    module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    thumbnails = module.get(ThumbnailService);
  }, 60_000);

  afterAll(async () => {
    await storageCtx.clearBucket();
    await storageCtx.module.close();
    await module.close();
  });

  it('should return a 1280×720 JPEG for a 1920×1080 video', async () => {
    const { url } = await uploadMediaFixture(storageCtx.storage, 'MP4_1080P');

    const jpeg = await thumbnails.extractThumbnail(url, thumbnailTimestamp(4));

    expect(jpeg.subarray(0, 2).equals(JPEG_SOI)).toBe(true);
    expect(probeImage(jpeg)).toEqual({
      codec: 'mjpeg',
      width: 1280,
      height: 720,
    });
  }, 30_000);

  it('should keep the original size (no upscale) for a 640×360 video', async () => {
    const { url } = await uploadMediaFixture(storageCtx.storage, 'MP4_360P');

    const jpeg = await thumbnails.extractThumbnail(url, thumbnailTimestamp(2));

    expect(jpeg.subarray(0, 2).equals(JPEG_SOI)).toBe(true);
    expect(probeImage(jpeg)).toEqual({
      codec: 'mjpeg',
      width: 640,
      height: 360,
    });
  }, 30_000);

  it('should reject with MediaTransientError when the source cannot be read', async () => {
    await expect(
      thumbnails.extractThumbnail('http://storage:9999/unreachable', 0),
    ).rejects.toBeInstanceOf(MediaTransientError);
  }, 30_000);
});
