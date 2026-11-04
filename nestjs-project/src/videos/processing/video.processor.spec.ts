import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { MediaProbeService } from '../../media/media-probe.service';
import {
  MediaTransientError,
  NoVideoStreamError,
  ProbeFailedError,
} from '../../media/media.errors';
import type { ProbeResult } from '../../media/media.types';
import { ThumbnailService } from '../../media/thumbnail.service';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { PROCESSING_URL_TTL_SECONDS } from '../videos.constants';
import { VideoProcessor, type ProcessVideoJob } from './video.processor';

const VIDEO_ID = '6f1c2a5e-2b7a-4a51-9a0e-9d3f4c1b2a10';
const SOURCE_URL = 'http://storage:9000/streamtube-videos/videos/x/source?sig';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const PROBE: ProbeResult = {
  durationSeconds: 40,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  sizeBytes: 1024,
  raw: { format: { duration: '40.0' }, streams: [] },
};

const job = (overrides: Partial<ProcessVideoJob> = {}): ProcessVideoJob =>
  ({
    id: VIDEO_ID,
    data: { videoId: VIDEO_ID },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  }) as ProcessVideoJob;

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storageService = { presignGetObject: jest.fn(), putObject: jest.fn() };
  const mediaProbeService = { probe: jest.fn() };
  const thumbnailService = { extractThumbnail: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    videoRepository.findOneBy.mockResolvedValue({
      id: VIDEO_ID,
      status: VideoStatus.PROCESSING,
      source_key: `videos/${VIDEO_ID}/source`,
    });
    videoRepository.update.mockResolvedValue({ affected: 1 });
    storageService.presignGetObject.mockResolvedValue(SOURCE_URL);
    storageService.putObject.mockResolvedValue(undefined);
    mediaProbeService.probe.mockResolvedValue(PROBE);
    thumbnailService.extractThumbnail.mockResolvedValue(JPEG);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: MediaProbeService, useValue: mediaProbeService },
        { provide: ThumbnailService, useValue: thumbnailService },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should probe, store the thumbnail and mark the video ready', async () => {
      await processor.process(job());

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/source`,
        PROCESSING_URL_TTL_SECONDS,
        { endpoint: 'internal' },
      );
      expect(mediaProbeService.probe).toHaveBeenCalledWith(SOURCE_URL);
      expect(thumbnailService.extractThumbnail).toHaveBeenCalledWith(
        SOURCE_URL,
        4, // 10% of 40 s
      );
      expect(storageService.putObject).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/thumbnail.jpg`,
        JPEG,
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.READY,
          duration_seconds: '40',
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          metadata: PROBE.raw,
          processing_error: null,
          thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
        },
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
      'should ignore a video in %s without touching media, storage or DB',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue({ id: VIDEO_ID, status });

        await processor.process(job());

        expect(mediaProbeService.probe).not.toHaveBeenCalled();
        expect(storageService.putObject).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
      },
    );

    it('should ignore a job whose video no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(processor.process(job())).resolves.toBeUndefined();
      expect(mediaProbeService.probe).not.toHaveBeenCalled();
    });

    it.each([
      ['NoVideoStreamError', new NoVideoStreamError(), /^NO_VIDEO_STREAM/],
      [
        'ProbeFailedError',
        new ProbeFailedError('Invalid data'),
        /^PROBE_FAILED/,
      ],
    ])(
      'should turn %s into an UnrecoverableError keeping the reason',
      async (_name, contentError, reason) => {
        mediaProbeService.probe.mockRejectedValue(contentError);

        const error: unknown = await processor.process(job()).then(
          () => null,
          (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(UnrecoverableError);
        expect((error as Error).message).toMatch(reason);
        expect(videoRepository.update).not.toHaveBeenCalled();
      },
    );

    it('should propagate transient media errors so BullMQ retries', async () => {
      const transient = new MediaTransientError('ffmpeg: Connection refused');
      thumbnailService.extractThumbnail.mockRejectedValue(transient);

      await expect(processor.process(job())).rejects.toBe(transient);
      expect(storageService.putObject).not.toHaveBeenCalled();
    });

    it('should propagate storage errors so BullMQ retries', async () => {
      const failure = new Error('storage down');
      storageService.putObject.mockRejectedValue(failure);

      await expect(processor.process(job())).rejects.toBe(failure);
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should record failed with the content reason on an unrecoverable error', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1 }),
        new UnrecoverableError('NO_VIDEO_STREAM: input has no video stream'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error: 'NO_VIDEO_STREAM: input has no video stream',
        },
      );
    });

    it('should not record anything while retries remain', async () => {
      await processor.onFailed(
        job({ attemptsMade: 2 }),
        new MediaTransientError('Connection refused'),
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should record PROCESSING_FAILED once the last attempt fails', async () => {
      await processor.onFailed(
        job({ attemptsMade: 3 }),
        new MediaTransientError('ffmpeg: Connection refused'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error:
            'PROCESSING_FAILED: MEDIA_TRANSIENT: ffmpeg: Connection refused',
        },
      );
    });

    it('should recognise an UnrecoverableError by name (deserialized errors)', async () => {
      const error = Object.assign(new Error('PROBE_FAILED: bad'), {
        name: 'UnrecoverableError',
      });

      await processor.onFailed(job({ attemptsMade: 1 }), error);

      expect(videoRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ processing_error: 'PROBE_FAILED: bad' }),
      );
    });

    it('should log instead of rethrowing when the DB update fails', async () => {
      videoRepository.update.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(job({ attemptsMade: 3 }), new Error('storage down')),
      ).resolves.toBeUndefined();
    });

    it('should ignore events without a job', async () => {
      await processor.onFailed(undefined, new Error('stalled'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});
