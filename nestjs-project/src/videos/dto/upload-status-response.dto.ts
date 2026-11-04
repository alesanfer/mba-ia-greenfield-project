import { ApiProperty } from '@nestjs/swagger';
import { UploadSessionDto } from './upload-session.dto';

export class UploadedPartDto {
  @ApiProperty({ example: 1, minimum: 1 })
  part_number: number;

  @ApiProperty({
    example: '"5d41402abc4b2a76b9719d911017c592"',
    description: 'ETag the storage returned for the part.',
  })
  etag: string;

  @ApiProperty({ example: 104857600, description: 'Part size in bytes.' })
  size: number;
}

/** Resume view: `parts` holds presigned URLs only for the missing parts. */
export class UploadStatusResponseDto extends UploadSessionDto {
  @ApiProperty({ type: [UploadedPartDto] })
  uploaded_parts: UploadedPartDto[];
}
