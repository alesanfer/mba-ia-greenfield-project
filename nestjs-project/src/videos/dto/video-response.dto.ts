import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

/**
 * Owner view of a video, in any status. Internal fields (`upload_id`,
 * `source_key`, `declared_size_bytes`, `channel_id`, `metadata`) are never
 * exposed.
 */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'aZ3kQ9xL0pT',
    description: 'Public 11-character base62 id — the video unique URL.',
  })
  public_id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 'aula.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 262144000,
    description: 'Real object size, known once the upload is completed.',
  })
  size_bytes: number | null;

  @ApiProperty({ type: 'number', nullable: true, example: 40.04 })
  duration_seconds: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'aac',
    description: 'Null when the video has no audio stream.',
  })
  audio_codec: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      'Presigned GET URL of the JPEG thumbnail; null until processing produces one.',
  })
  thumbnail_url: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: null,
    description: 'Failure reason when status is "failed".',
  })
  processing_error: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  created_at: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updated_at: string;
}
