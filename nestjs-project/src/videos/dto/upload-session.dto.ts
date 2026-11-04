import { ApiProperty } from '@nestjs/swagger';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1, minimum: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Presigned `UploadPart` URL. `PUT` the part bytes straight to it and keep the `ETag` response header.',
    example:
      'http://localhost:9000/streamtube-videos/videos/…/source?partNumber=1&uploadId=…&X-Amz-Signature=…',
  })
  url: string;
}

export class UploadSessionDto {
  @ApiProperty({ example: 104857600, description: 'Part size in bytes.' })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;

  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({
    format: 'date-time',
    description: 'When the part URLs stop working.',
  })
  expires_at: string;
}
