import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';

/**
 * Producer side of the `video-processing` queue. It deliberately registers no
 * `@Processor`: consuming jobs (FFmpeg) happens only in the `WorkerModule`.
 * Requires `QueueModule` (shared connection) in the importing process.
 */
@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })],
  providers: [VideoProcessingQueue],
  exports: [VideoProcessingQueue],
})
export class VideoProcessingModule {}
