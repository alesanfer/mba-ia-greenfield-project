import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { SignedUrlResponseDto } from './dto/signed-url-response.dto';
import { UploadStatusResponseDto } from './dto/upload-status-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const PUBLIC_ID_PARAM = {
  name: 'public_id',
  description: 'Public 11-character id of the video',
  example: 'aZ3kQ9xL0pT',
} as const;

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft in the authenticated user's channel, opens a multipart upload and returns one presigned URL per 100 MiB part. The client PUTs each part straight to the storage; the video bytes never pass through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload started',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (MIME type not allowed, size outside 1 B..10 GiB, missing fields)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':public_id')
  @ApiOperation({
    summary: 'Get a video of the own channel',
    description:
      'Returns status, extracted metadata and a presigned thumbnail URL of a video of the authenticated user channel, in any status — used to follow processing. Videos of other channels answer 404.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Video found in the user channel',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the user channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(user.sub, publicId);
  }

  @Get(':public_id/stream')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a presigned URL (valid for 1 h) of the original file on the storage. The storage answers HTTP Range requests with 206, so players read it progressively. Only the channel owner, only for ready videos.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the user channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getStreamUrl(user.sub, publicId);
  }

  @Get(':public_id/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned URL (valid for 15 min) that downloads the original file with its original name (Content-Disposition: attachment). Only the channel owner, only for ready videos.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the user channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, publicId);
  }

  @Get(':public_id/upload')
  @ApiOperation({
    summary: 'Resume a video upload',
    description:
      'Lists the parts the storage already received and returns fresh presigned URLs only for the missing ones. Only the channel owner can resume, and only while the video is a draft with an open upload.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Upload status with URLs for the missing parts',
    type: UploadStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the user channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'Video is not a draft or its upload was already completed (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<UploadStatusResponseDto> {
    return this.videosService.getUploadStatus(user.sub, publicId);
  }

  @Post(':public_id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, checks the real object size against the declared one and schedules background processing (draft → processing). Safe to retry after a 503: the parts are not needed again.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 202,
    description: 'Upload completed, processing scheduled',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR) or the storage rejected the parts list (INVALID_UPLOAD_PARTS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the user channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Uploaded size differs from the declared size; object and draft were removed (UPLOAD_SIZE_MISMATCH)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'Processing could not be scheduled; video is back to draft, retry the call (QUEUE_UNAVAILABLE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Delete(':public_id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel a video upload',
    description:
      'Aborts the multipart upload, removes any uploaded object and deletes the draft. Only the channel owner can cancel, and only while the video is a draft.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Upload cancelled, draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the user channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('public_id') publicId: string,
  ): Promise<void> {
    await this.videosService.cancelUpload(user.sub, publicId);
  }
}
