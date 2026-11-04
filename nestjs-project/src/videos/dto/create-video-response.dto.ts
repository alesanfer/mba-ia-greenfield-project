import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';
import { UploadSessionDto } from './upload-session.dto';

export class CreateVideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'aZ3kQ9xL0pT',
    description: 'Public 11-character base62 id — the video unique URL.',
  })
  public_id: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: [VideoStatus.DRAFT], example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: UploadSessionDto })
  upload: UploadSessionDto;
}
