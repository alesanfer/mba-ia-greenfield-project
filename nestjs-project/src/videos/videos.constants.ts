/** 10 GiB (10 × 1024³). */
export const MAX_VIDEO_SIZE_BYTES = 10_737_418_240;

/** Fixed 100 MiB parts; the last one may be smaller (≤ 103 parts for 10 GiB). */
export const UPLOAD_PART_SIZE_BYTES = 104_857_600;

/** Allowlist served as-is (no transcoding). */
export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number];

export const UPLOAD_PART_URL_TTL_SECONDS = 3600;
export const STREAM_URL_TTL_SECONDS = 3600;
export const DOWNLOAD_URL_TTL_SECONDS = 900;
export const THUMBNAIL_URL_TTL_SECONDS = 3600;
export const PROCESSING_URL_TTL_SECONDS = 900;

/** Attempts to insert a draft with a fresh `public_id` on unique collisions. */
export const PUBLIC_ID_MAX_ATTEMPTS = 5;

export const videoSourceKey = (videoId: string): string =>
  `videos/${videoId}/source`;
export const videoThumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
