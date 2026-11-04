import { Module } from '@nestjs/common';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';

/** Thin wrappers over the system ffprobe/ffmpeg binaries (worker only). */
@Module({
  providers: [MediaProbeService, ThumbnailService],
  exports: [MediaProbeService, ThumbnailService],
})
export class MediaModule {}
