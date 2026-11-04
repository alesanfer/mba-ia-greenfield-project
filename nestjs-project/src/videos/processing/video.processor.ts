import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { MediaError } from '../../media/media.errors';
import { MediaProbeService } from '../../media/media-probe.service';
import type { ProbeResult } from '../../media/media.types';
import {
  ThumbnailService,
  thumbnailTimestamp,
} from '../../media/thumbnail.service';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  PROCESSING_URL_TTL_SECONDS,
  videoThumbnailKey,
} from '../videos.constants';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

/** Prefix of `processing_error` once transient failures used every attempt. */
export const PROCESSING_FAILED_PREFIX = 'PROCESSING_FAILED';

export type ProcessVideoJob = Job<ProcessVideoJobData, void, string>;

const isUnrecoverable = (error: Error): boolean =>
  error instanceof UnrecoverableError || error.name === 'UnrecoverableError';

/**
 * Consumer of `process-video` jobs. Registered only by the `WorkerModule`
 * (video-worker container), never by the API's `AppModule`.
 *
 * Delivery is at-least-once, so `process` is idempotent: it only acts on
 * videos still in `processing`, overwrites the thumbnail and commits with a
 * conditional `WHERE status = 'processing'`.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
    private readonly thumbnailService: ThumbnailService,
  ) {
    super();
  }

  async process(job: ProcessVideoJob): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (video?.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping job ${job.id}: video ${videoId} is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    // Short-lived internal URL; FFmpeg reads it with HTTP Range requests.
    const sourceUrl = await this.storageService.presignGetObject(
      video.source_key,
      PROCESSING_URL_TTL_SECONDS,
      { endpoint: 'internal' },
    );

    const probe = await this.runMedia(() =>
      this.mediaProbeService.probe(sourceUrl),
    );
    const jpeg = await this.runMedia(() =>
      this.thumbnailService.extractThumbnail(
        sourceUrl,
        thumbnailTimestamp(probe.durationSeconds),
      ),
    );

    const thumbnailKey = videoThumbnailKey(video.id);
    await this.storageService.putObject(thumbnailKey, jpeg, 'image/jpeg');

    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      { ...this.metadataColumns(probe), thumbnail_key: thumbnailKey },
    );
    if (!affected) {
      this.logger.warn(
        `Video ${video.id} left processing while job ${job.id} ran; result discarded`,
      );
    }
  }

  /**
   * Called by BullMQ after every failed attempt. Records `failed` only when no
   * retry is coming: unrecoverable content error, or last attempt used.
   * Background handler: logs instead of rethrowing (would crash the worker).
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: ProcessVideoJob | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const unrecoverable = isUnrecoverable(error);
    const attempts = job.opts.attempts ?? 1;
    if (!unrecoverable && job.attemptsMade < attempts) {
      this.logger.warn(
        `Job ${job.id} attempt ${job.attemptsMade}/${attempts} failed, will retry: ${error.message}`,
      );
      return;
    }

    const reason = unrecoverable
      ? error.message
      : `${PROCESSING_FAILED_PREFIX}: ${error.message}`;
    this.logger.error(
      `Video ${job.data.videoId} failed: ${reason}`,
      error.stack,
    );
    try {
      await this.videoRepository.update(
        { id: job.data.videoId, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, processing_error: reason },
      );
    } catch (dbError) {
      this.logger.error(
        `Could not record failure of video ${job.data.videoId}`,
        dbError instanceof Error ? dbError.stack : String(dbError),
      );
    }
  }

  /** Content errors (no video stream, unreadable media) never get retried. */
  private async runMedia<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof MediaError && error.permanent) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private metadataColumns(probe: ProbeResult): QueryDeepPartialEntity<Video> {
    return {
      status: VideoStatus.READY,
      duration_seconds:
        probe.durationSeconds === null ? null : String(probe.durationSeconds),
      width: probe.width,
      height: probe.height,
      video_codec: probe.videoCodec,
      audio_codec: probe.audioCodec,
      // TypeORM's deep-partial typing cannot express an arbitrary JSON
      // object for a `jsonb` column; the value is stored as-is.
      metadata: probe.raw as QueryDeepPartialEntity<Video>['metadata'],
      processing_error: null,
    };
  }
}
