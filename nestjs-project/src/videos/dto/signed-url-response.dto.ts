import { ApiProperty } from '@nestjs/swagger';

/** Presigned storage URL; the video bytes never pass through the API. */
export class SignedUrlResponseDto {
  @ApiProperty({
    format: 'uri',
    description:
      'Presigned GET URL on the public storage endpoint. Supports HTTP Range requests (206 Partial Content).',
  })
  url: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  expires_at: string;
}
