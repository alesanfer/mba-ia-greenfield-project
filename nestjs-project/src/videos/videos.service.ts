import { randomUUID } from 'crypto';
import { parse } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, type Repository } from 'typeorm';
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
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreateVideoResponseDto } from './dto/create-video-response.dto';
import type { SignedUrlResponseDto } from './dto/signed-url-response.dto';
import type { UploadSessionDto } from './dto/upload-session.dto';
import type { UploadStatusResponseDto } from './dto/upload-status-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { ProcessingQueueUnavailableError } from './processing/video-processing.errors';
import { VideoProcessingQueue } from './processing/video-processing.queue';
import { generatePublicId } from './public-id.util';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  PUBLIC_ID_MAX_ATTEMPTS,
  STREAM_URL_TTL_SECONDS,
  THUMBNAIL_URL_TTL_SECONDS,
  UPLOAD_PART_SIZE_BYTES,
  UPLOAD_PART_URL_TTL_SECONDS,
  videoSourceKey,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error.driverError as {
    code?: string;
    detail?: string;
  };
  return code === PG_UNIQUE_VIOLATION && !!detail?.includes(PUBLIC_ID_COLUMN);
}

function partCountFor(sizeBytes: number): number {
  return Math.ceil(sizeBytes / UPLOAD_PART_SIZE_BYTES);
}

/** `aula.final.mp4` → `aula.final`; names without extension stay as-is. */
function titleFromFilename(filename: string): string {
  return parse(filename).name || filename;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingQueue: VideoProcessingQueue,
  ) {}

  /**
   * Pre-registers the video as `draft` in the user's channel, opens the
   * multipart upload and returns one presigned URL per part. The file bytes
   * go straight to the storage; they never pass through the API.
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration; this is a broken invariant.
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const sourceKey = videoSourceKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.mime_type,
    );

    let video: Video;
    try {
      video = await this.insertDraft({
        id,
        channel_id: channel.id,
        title: dto.title ?? titleFromFilename(dto.filename),
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        mime_type: dto.mime_type,
        declared_size_bytes: String(dto.size_bytes),
        upload_id: uploadId,
        source_key: sourceKey,
      });
    } catch (error) {
      await this.abortUploadQuietly(sourceKey, uploadId);
      throw error;
    }

    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      upload: await this.buildUploadSession(
        sourceKey,
        uploadId,
        partCountFor(dto.size_bytes),
      ),
    };
  }

  /**
   * Loads a video of the user's own channel. Missing and foreign videos are
   * indistinguishable (404) so the API never reveals that a video exists.
   */
  async findOwnedByPublicId(userId: string, publicId: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = channel
      ? await this.videoRepository.findOneBy({
          public_id: publicId,
          channel_id: channel.id,
        })
      : null;
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  /**
   * Owner view of a video in any status, to follow its processing. The
   * thumbnail is served through a short-lived presigned URL on the public
   * storage endpoint; internal fields stay out of the response.
   */
  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGetObject(
          video.thumbnail_key,
          THUMBNAIL_URL_TTL_SECONDS,
          { endpoint: 'public' },
        )
      : null;

    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      mime_type: video.mime_type,
      // bigint and numeric columns come back from pg as strings.
      size_bytes: video.size_bytes === null ? null : Number(video.size_bytes),
      duration_seconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      thumbnail_url: thumbnailUrl,
      processing_error: video.processing_error,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }

  /**
   * Presigned URL of the original file for progressive playback: the storage
   * answers `Range` requests with `206 Partial Content`.
   */
  async getStreamUrl(
    userId: string,
    publicId: string,
  ): Promise<SignedUrlResponseDto> {
    const video = await this.findOwnedReadyVideo(userId, publicId);
    return this.signSource(video, STREAM_URL_TTL_SECONDS);
  }

  /** Same as the stream URL, but forces a download with the original name. */
  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<SignedUrlResponseDto> {
    const video = await this.findOwnedReadyVideo(userId, publicId);
    return this.signSource(
      video,
      DOWNLOAD_URL_TTL_SECONDS,
      video.original_filename,
    );
  }

  /**
   * Resumes an interrupted upload: lists the parts the storage already has and
   * presigns only the missing ones.
   */
  async getUploadStatus(
    userId: string,
    publicId: string,
  ): Promise<UploadStatusResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStateException();
    }

    const uploaded = await this.storageService.listParts(
      video.source_key,
      video.upload_id,
    );
    const session = await this.buildUploadSession(
      video.source_key,
      video.upload_id,
      partCountFor(Number(video.declared_size_bytes)),
      new Set(uploaded.map((part) => part.partNumber)),
    );

    return {
      ...session,
      uploaded_parts: uploaded.map(({ partNumber, etag, size }) => ({
        part_number: partNumber,
        etag,
        size,
      })),
    };
  }

  /**
   * Cancels the upload: aborts the multipart (when still open), removes the
   * object if it was already assembled and deletes the draft. Safe to retry.
   */
  async cancelUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException();
    }

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.source_key,
        video.upload_id,
      );
    }
    if ((await this.storageService.headObject(video.source_key)) !== null) {
      await this.storageService.deleteObject(video.source_key);
    }
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Finishes the upload and hands the video to the worker (`draft →
   * processing`). Idempotent after a queue failure: the draft keeps
   * `upload_id = null`, so a retry skips `CompleteMultipartUpload` and only
   * re-checks the size and re-enqueues.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidVideoStateException();
    }

    // 1. Assemble the object (skipped on retries: multipart already completed).
    if (video.upload_id) {
      await this.completeMultipart(video, video.upload_id, dto);
      await this.videoRepository.update({ id: video.id }, { upload_id: null });
    }

    // 2. The real size must match what the client declared.
    const actualSize = await this.storageService.headObject(video.source_key);
    if (
      actualSize === null ||
      actualSize !== Number(video.declared_size_bytes)
    ) {
      if (actualSize !== null) {
        await this.storageService.deleteObject(video.source_key);
      }
      await this.videoRepository.delete({ id: video.id });
      throw new UploadSizeMismatchException();
    }

    // 3. Hand over to the worker. Conditional on `draft` against races.
    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, size_bytes: String(actualSize) },
    );
    if (!affected) throw new InvalidVideoStateException();

    // 4. Publish the job; on failure go back to `draft` so the client retries.
    try {
      await this.videoProcessingQueue.enqueue(video.id);
    } catch (error) {
      if (!(error instanceof ProcessingQueueUnavailableError)) throw error;
      await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      throw new QueueUnavailableException();
    }

    return {
      id: video.id,
      public_id: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  private async findOwnedReadyVideo(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.READY) {
      throw new InvalidVideoStateException();
    }
    return video;
  }

  private async signSource(
    video: Video,
    ttlSeconds: number,
    downloadFilename?: string,
  ): Promise<SignedUrlResponseDto> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const url = await this.storageService.presignGetObject(
      video.source_key,
      ttlSeconds,
      { endpoint: 'public', downloadFilename },
    );
    return { url, expires_at: expiresAt.toISOString() };
  }

  private async completeMultipart(
    video: Video,
    uploadId: string,
    dto: CompleteUploadDto,
  ): Promise<void> {
    const parts = [...dto.parts]
      .sort((a, b) => a.part_number - b.part_number)
      .map(({ part_number, etag }) => ({ partNumber: part_number, etag }));
    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        uploadId,
        parts,
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartsError) {
        throw new InvalidUploadPartsException();
      }
      throw error;
    }
  }

  /** Presigns every part of `1..partCount` not in `skipParts`. */
  private async buildUploadSession(
    sourceKey: string,
    uploadId: string,
    partCount: number,
    skipParts: ReadonlySet<number> = new Set(),
  ): Promise<UploadSessionDto> {
    const expiresAt = new Date(Date.now() + UPLOAD_PART_URL_TTL_SECONDS * 1000);
    const pending = Array.from(
      { length: partCount },
      (_, index) => index + 1,
    ).filter((partNumber) => !skipParts.has(partNumber));

    const parts = await Promise.all(
      pending.map(async (partNumber) => {
        return {
          part_number: partNumber,
          url: await this.storageService.presignUploadPart(
            sourceKey,
            uploadId,
            partNumber,
            UPLOAD_PART_URL_TTL_SECONDS,
          ),
        };
      }),
    );

    return {
      part_size: UPLOAD_PART_SIZE_BYTES,
      part_count: partCount,
      parts,
      expires_at: expiresAt.toISOString(),
    };
  }

  /** Inserts the draft, drawing a new `public_id` on unique collisions. */
  private async insertDraft(
    fields: Omit<Partial<Video>, 'public_id'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: generatePublicId(),
          }),
        );
      } catch (error) {
        if (!isPublicIdCollision(error) || attempt >= PUBLIC_ID_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  /**
   * Compensation for a failed insert. Its own failure must not hide the
   * original error, so it is logged; the dangling upload is left for the
   * abandoned-uploads cleanup (future task, per TD-06 Revision).
   */
  private async abortUploadQuietly(
    sourceKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(sourceKey, uploadId);
    } catch (abortError) {
      this.logger.error(
        `Failed to abort multipart upload ${uploadId} for ${sourceKey}`,
        abortError instanceof Error ? abortError.stack : String(abortError),
      );
    }
  }
}
