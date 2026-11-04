import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_SIZE_BYTES,
  type AllowedVideoMimeType,
} from '../videos.constants';

export class CreateVideoDto {
  /** Original file name, e.g. `aula.mp4`. Used as default title and download name. */
  @IsString()
  @Length(1, 255)
  filename: string;

  /** MIME type of the file. Only `video/mp4` and `video/webm` are accepted. */
  @IsIn(ALLOWED_VIDEO_MIME_TYPES)
  mime_type: AllowedVideoMimeType;

  /** Exact file size in bytes (max 10 GiB). Defines how many parts to upload. */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;

  /** Video title. Defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;
}
