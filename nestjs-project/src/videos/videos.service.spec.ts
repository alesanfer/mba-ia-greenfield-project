import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsException,
  InvalidVideoStateException,
  QueueUnavailableException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageInvalidPartsError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { ProcessingQueueUnavailableError } from './processing/video-processing.errors';
import { VideoProcessingQueue } from './processing/video-processing.queue';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  PUBLIC_ID_MAX_ATTEMPTS,
  STREAM_URL_TTL_SECONDS,
  THUMBNAIL_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
  UPLOAD_PART_URL_TTL_SECONDS,
} from './videos.constants';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };
const UPLOAD_ID = 'upload-123';

const uniqueViolation = (column: string): QueryFailedError =>
  new QueryFailedError('INSERT INTO "videos"', [], {
    code: '23505',
    detail: `Key (${column})=(abc) already exists.`,
  } as unknown as Error);

const PUBLIC_ID = 'aZ3kQ9xL0pT';
const SOURCE_KEY = 'videos/video-1/source';

const storedVideo = (overrides: Partial<Video> = {}): Video =>
  ({
    id: 'video-1',
    public_id: PUBLIC_ID,
    channel_id: CHANNEL.id,
    status: VideoStatus.DRAFT,
    upload_id: UPLOAD_ID,
    source_key: SOURCE_KEY,
    declared_size_bytes: String(UPLOAD_PART_SIZE_BYTES * 2 + 1024),
    ...overrides,
  }) as Video;

const dto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
  filename: 'aula.mp4',
  mime_type: 'video/mp4',
  size_bytes: 1024,
  ...overrides,
});

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
    save: jest.fn((video: Video) => Promise.resolve(video)),
    findOneBy: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
  };
  const videoProcessingQueue = { enqueue: jest.fn() };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    abortMultipartUpload: jest.fn(),
    listParts: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
    completeMultipartUpload: jest.fn(),
    presignGetObject: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue(CHANNEL);
    storageService.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    storageService.presignUploadPart.mockImplementation(
      (_key: string, _uploadId: string, part: number) =>
        Promise.resolve(`http://storage:9000/part-${part}`),
    );
    storageService.abortMultipartUpload.mockResolvedValue(undefined);
    videoRepository.update.mockResolvedValue({ affected: 1 });
    videoProcessingQueue.enqueue.mockResolvedValue(undefined);
    storageService.completeMultipartUpload.mockResolvedValue(undefined);
    videoRepository.save.mockImplementation((video: Video) =>
      Promise.resolve(video),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingQueue, useValue: videoProcessingQueue },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it('should default the title to the file name without its extension', async () => {
      const result = await service.createDraft(
        USER_ID,
        dto({ filename: 'minha.aula.final.mp4' }),
      );

      expect(result.title).toBe('minha.aula.final');
    });

    it('should keep the informed title', async () => {
      const result = await service.createDraft(
        USER_ID,
        dto({ title: 'Introdução ao NestJS' }),
      );

      expect(result.title).toBe('Introdução ao NestJS');
    });

    it('should persist a draft in the user channel with the upload id and source key', async () => {
      const result = await service.createDraft(
        USER_ID,
        dto({ size_bytes: 5000 }),
      );

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/source`,
        'video/mp4',
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          channel_id: CHANNEL.id,
          status: VideoStatus.DRAFT,
          upload_id: UPLOAD_ID,
          source_key: `videos/${result.id}/source`,
          original_filename: 'aula.mp4',
          declared_size_bytes: '5000',
        }),
      );
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
    });

    it.each([
      { size: UPLOAD_PART_SIZE_BYTES, parts: 1 },
      { size: UPLOAD_PART_SIZE_BYTES * 3, parts: 3 },
      { size: 1, parts: 1 },
      { size: UPLOAD_PART_SIZE_BYTES + 1, parts: 2 },
      { size: 262_144_000, parts: 3 },
      { size: 10_737_418_240, parts: 103 },
    ])(
      'should split $size bytes into $parts part(s)',
      async ({ size, parts }) => {
        const result = await service.createDraft(
          USER_ID,
          dto({ size_bytes: size }),
        );

        expect(result.upload.part_size).toBe(UPLOAD_PART_SIZE_BYTES);
        expect(result.upload.part_count).toBe(parts);
        expect(result.upload.parts.map((p) => p.part_number)).toEqual(
          Array.from({ length: parts }, (_, i) => i + 1),
        );
        expect(storageService.presignUploadPart).toHaveBeenCalledTimes(parts);
        expect(storageService.presignUploadPart).toHaveBeenLastCalledWith(
          expect.any(String),
          UPLOAD_ID,
          parts,
          UPLOAD_PART_URL_TTL_SECONDS,
        );
      },
    );

    it('should expire the part URLs after the part URL TTL', async () => {
      const before = Date.now();

      const result = await service.createDraft(USER_ID, dto());

      const expiresAt = Date.parse(result.upload.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(
        before + UPLOAD_PART_URL_TTL_SECONDS * 1000,
      );
      expect(expiresAt).toBeLessThanOrEqual(
        Date.now() + UPLOAD_PART_URL_TTL_SECONDS * 1000,
      );
    });

    it('should retry with a new public_id when it collides', async () => {
      videoRepository.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockRejectedValueOnce(uniqueViolation('public_id'));

      const result = await service.createDraft(USER_ID, dto());

      expect(videoRepository.save).toHaveBeenCalledTimes(3);
      const tried = videoRepository.create.mock.calls.map(
        ([fields]) => fields.public_id,
      );
      expect(new Set(tried).size).toBe(3);
      expect(result.public_id).toBe(tried[2]);
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should give up after the max attempts and abort the upload', async () => {
      videoRepository.save.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.createDraft(USER_ID, dto())).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(
        PUBLIC_ID_MAX_ATTEMPTS,
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        UPLOAD_ID,
      );
    });

    it('should abort the upload without retrying when the insert fails for another reason', async () => {
      const failure = new Error('connection lost');
      videoRepository.save.mockRejectedValue(failure);

      await expect(service.createDraft(USER_ID, dto())).rejects.toBe(failure);
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should not retry a unique violation on another column', async () => {
      videoRepository.save.mockRejectedValue(uniqueViolation('id'));

      await expect(service.createDraft(USER_ID, dto())).rejects.toBeInstanceOf(
        QueryFailedError,
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
    });

    it('should rethrow the insert error even if the abort also fails', async () => {
      const failure = new Error('insert failed');
      videoRepository.save.mockRejectedValue(failure);
      storageService.abortMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.createDraft(USER_ID, dto())).rejects.toBe(failure);
    });

    it('should fail without touching the storage when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft(USER_ID, dto())).rejects.toThrow(
        /has no channel/,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('findOwnedByPublicId', () => {
    it('should look the video up only inside the user channel', async () => {
      const video = storedVideo();
      videoRepository.findOneBy.mockResolvedValue(video);

      await expect(
        service.findOwnedByPublicId(USER_ID, PUBLIC_ID),
      ).resolves.toBe(video);
      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        public_id: PUBLIC_ID,
        channel_id: CHANNEL.id,
      });
    });

    it('should throw VideoNotFoundException for a missing or foreign video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.findOwnedByPublicId(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw VideoNotFoundException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.findOwnedByPublicId(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOneBy).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedVideo', () => {
    const CREATED_AT = new Date('2026-11-04T10:00:00.000Z');
    const UPDATED_AT = new Date('2026-11-04T10:05:00.000Z');
    const THUMBNAIL_KEY = 'videos/video-1/thumbnail.jpg';
    const THUMBNAIL_URL = 'http://localhost:9000/thumb?sig';

    const readyVideo = (overrides: Partial<Video> = {}): Video =>
      storedVideo({
        title: 'aula',
        status: VideoStatus.READY,
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        upload_id: null,
        size_bytes: '262144000',
        duration_seconds: '40.040',
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        metadata: { format: {} },
        thumbnail_key: THUMBNAIL_KEY,
        processing_error: null,
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
        ...overrides,
      });

    it('should sign the thumbnail on the public endpoint and convert numeric columns', async () => {
      videoRepository.findOneBy.mockResolvedValue(readyVideo());
      storageService.presignGetObject.mockResolvedValue(THUMBNAIL_URL);

      const result = await service.getOwnedVideo(USER_ID, PUBLIC_ID);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        THUMBNAIL_KEY,
        THUMBNAIL_URL_TTL_SECONDS,
        { endpoint: 'public' },
      );
      expect(result).toEqual({
        id: 'video-1',
        public_id: PUBLIC_ID,
        title: 'aula',
        status: VideoStatus.READY,
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: 262144000,
        duration_seconds: 40.04,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        thumbnail_url: THUMBNAIL_URL,
        processing_error: null,
        created_at: CREATED_AT.toISOString(),
        updated_at: UPDATED_AT.toISOString(),
      });
    });

    it('should return a null thumbnail_url without signing when there is no thumbnail', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        readyVideo({
          status: VideoStatus.DRAFT,
          upload_id: UPLOAD_ID,
          size_bytes: null,
          duration_seconds: null,
          thumbnail_key: null,
        }),
      );

      const result = await service.getOwnedVideo(USER_ID, PUBLIC_ID);

      expect(result).toMatchObject({
        thumbnail_url: null,
        size_bytes: null,
        duration_seconds: null,
      });
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it('should never expose internal fields', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        readyVideo({ upload_id: UPLOAD_ID }),
      );
      storageService.presignGetObject.mockResolvedValue(THUMBNAIL_URL);

      const result = await service.getOwnedVideo(USER_ID, PUBLIC_ID);

      for (const key of [
        'upload_id',
        'source_key',
        'declared_size_bytes',
        'channel_id',
        'metadata',
        'thumbnail_key',
      ]) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it('should propagate VideoNotFoundException for a foreign video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.getOwnedVideo(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    const SIGNED_URL = 'http://localhost:9000/source?sig';
    const NOW = new Date('2026-11-04T12:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
      storageService.presignGetObject.mockResolvedValue(SIGNED_URL);
      videoRepository.findOneBy.mockResolvedValue(
        storedVideo({
          status: VideoStatus.READY,
          upload_id: null,
          original_filename: 'minha-aula.mp4',
        }),
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should sign the source on the public endpoint for 1 h to stream', async () => {
      const result = await service.getStreamUrl(USER_ID, PUBLIC_ID);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        SOURCE_KEY,
        STREAM_URL_TTL_SECONDS,
        { endpoint: 'public', downloadFilename: undefined },
      );
      expect(STREAM_URL_TTL_SECONDS).toBe(3600);
      expect(result).toEqual({
        url: SIGNED_URL,
        expires_at: new Date(
          NOW.getTime() + STREAM_URL_TTL_SECONDS * 1000,
        ).toISOString(),
      });
    });

    it('should sign the source for 15 min with the original file name to download', async () => {
      const result = await service.getDownloadUrl(USER_ID, PUBLIC_ID);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        SOURCE_KEY,
        DOWNLOAD_URL_TTL_SECONDS,
        { endpoint: 'public', downloadFilename: 'minha-aula.mp4' },
      );
      expect(DOWNLOAD_URL_TTL_SECONDS).toBe(900);
      expect(result.expires_at).toBe(
        new Date(NOW.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should reject a video in %s without signing anything',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(storedVideo({ status }));

        await expect(
          service.getStreamUrl(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStateException);
        await expect(
          service.getDownloadUrl(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStateException);
        expect(storageService.presignGetObject).not.toHaveBeenCalled();
      },
    );

    it('should propagate VideoNotFoundException for a foreign video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.getDownloadUrl(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getUploadStatus', () => {
    it('should list the received parts and presign only the missing ones', async () => {
      videoRepository.findOneBy.mockResolvedValue(storedVideo());
      storageService.listParts.mockResolvedValue([
        { partNumber: 2, etag: '"etag-2"', size: UPLOAD_PART_SIZE_BYTES },
      ]);

      const result = await service.getUploadStatus(USER_ID, PUBLIC_ID);

      expect(storageService.listParts).toHaveBeenCalledWith(
        SOURCE_KEY,
        UPLOAD_ID,
      );
      expect(result.part_size).toBe(UPLOAD_PART_SIZE_BYTES);
      expect(result.part_count).toBe(3);
      expect(result.uploaded_parts).toEqual([
        { part_number: 2, etag: '"etag-2"', size: UPLOAD_PART_SIZE_BYTES },
      ]);
      expect(result.parts.map((p) => p.part_number)).toEqual([1, 3]);
      expect(storageService.presignUploadPart).toHaveBeenCalledTimes(2);
    });

    it('should return no URLs when every part was received', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        storedVideo({ declared_size_bytes: '10' }),
      );
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"etag-1"', size: 10 },
      ]);

      const result = await service.getUploadStatus(USER_ID, PUBLIC_ID);

      expect(result.part_count).toBe(1);
      expect(result.parts).toEqual([]);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a video in %s with InvalidVideoStateException',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(storedVideo({ status }));

        await expect(
          service.getUploadStatus(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStateException);
        expect(storageService.listParts).not.toHaveBeenCalled();
      },
    );

    it('should reject a draft whose multipart was already completed (upload_id null)', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        storedVideo({ upload_id: null }),
      );

      await expect(
        service.getUploadStatus(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });

    it('should propagate VideoNotFoundException for a foreign video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.getUploadStatus(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('cancelUpload', () => {
    it('should abort the open multipart and delete the draft', async () => {
      videoRepository.findOneBy.mockResolvedValue(storedVideo());
      storageService.headObject.mockResolvedValue(null);

      await service.cancelUpload(USER_ID, PUBLIC_ID);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        SOURCE_KEY,
        UPLOAD_ID,
      );
      expect(storageService.deleteObject).not.toHaveBeenCalled();
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should only remove the object and the draft when upload_id is null', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        storedVideo({ upload_id: null }),
      );
      storageService.headObject.mockResolvedValue(2048);

      await service.cancelUpload(USER_ID, PUBLIC_ID);

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.deleteObject).toHaveBeenCalledWith(SOURCE_KEY);
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a video in %s without touching storage or DB',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(storedVideo({ status }));

        await expect(
          service.cancelUpload(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStateException);
        expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
        expect(storageService.deleteObject).not.toHaveBeenCalled();
        expect(videoRepository.delete).not.toHaveBeenCalled();
      },
    );

    it('should keep the draft when the storage abort fails', async () => {
      videoRepository.findOneBy.mockResolvedValue(storedVideo());
      storageService.abortMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.cancelUpload(USER_ID, PUBLIC_ID)).rejects.toThrow(
        'storage down',
      );
      expect(videoRepository.delete).not.toHaveBeenCalled();
    });

    it('should propagate VideoNotFoundException for a foreign video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.cancelUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const DECLARED = 2048;
    const PARTS = {
      parts: [
        { part_number: 2, etag: '"etag-2"' },
        { part_number: 1, etag: '"etag-1"' },
      ],
    };
    const draft = (overrides: Partial<Video> = {}): Video =>
      storedVideo({ declared_size_bytes: String(DECLARED), ...overrides });

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(draft());
      storageService.headObject.mockResolvedValue(DECLARED);
    });

    it('should complete the multipart, move to processing and enqueue the job', async () => {
      const result = await service.completeUpload(USER_ID, PUBLIC_ID, PARTS);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        SOURCE_KEY,
        UPLOAD_ID,
        [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      );
      expect(videoRepository.update).toHaveBeenNthCalledWith(
        1,
        { id: 'video-1' },
        { upload_id: null },
      );
      expect(videoRepository.update).toHaveBeenNthCalledWith(
        2,
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, size_bytes: String(DECLARED) },
      );
      expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith('video-1');
      expect(result).toEqual({
        id: 'video-1',
        public_id: PUBLIC_ID,
        status: VideoStatus.PROCESSING,
      });
    });

    it('should map rejected parts to InvalidUploadPartsException and keep the draft', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new StorageInvalidPartsError('InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(videoRepository.delete).not.toHaveBeenCalled();
      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should propagate other storage errors as-is', async () => {
      const failure = new Error('storage down');
      storageService.completeMultipartUpload.mockRejectedValue(failure);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBe(failure);
    });

    it('should remove object and draft and throw UploadSizeMismatchException when the size differs', async () => {
      storageService.headObject.mockResolvedValue(DECLARED - 1);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(SOURCE_KEY);
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'video-1' });
      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should drop the draft when the assembled object is missing', async () => {
      videoRepository.findOneBy.mockResolvedValue(draft({ upload_id: null }));
      storageService.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.deleteObject).not.toHaveBeenCalled();
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should revert to draft and throw QueueUnavailableException when enqueue fails', async () => {
      videoProcessingQueue.enqueue.mockRejectedValue(
        new ProcessingQueueUnavailableError('video-1'),
      );

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBeInstanceOf(QueueUnavailableException);
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      // upload_id was cleared before and is not restored.
      expect(videoRepository.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ upload_id: UPLOAD_ID }),
      );
    });

    it('should skip CompleteMultipartUpload on a retry (upload_id null)', async () => {
      videoRepository.findOneBy.mockResolvedValue(draft({ upload_id: null }));

      const result = await service.completeUpload(USER_ID, PUBLIC_ID, PARTS);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.headObject).toHaveBeenCalledWith(SOURCE_KEY);
      expect(videoProcessingQueue.enqueue).toHaveBeenCalledWith('video-1');
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject a video in %s with InvalidVideoStateException',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(draft({ status }));

        await expect(
          service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
        ).rejects.toBeInstanceOf(InvalidVideoStateException);
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
        expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
      },
    );

    it('should not enqueue when another request already moved the video out of draft', async () => {
      videoRepository.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
      expect(videoProcessingQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should propagate VideoNotFoundException for a foreign video', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID, PARTS),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
