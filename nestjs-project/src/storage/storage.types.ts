export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ListedPart extends UploadedPart {
  size: number;
}

export type SigningEndpoint = 'public' | 'internal';

export interface PresignGetObjectOptions {
  /** `public` signs with `S3_PUBLIC_ENDPOINT` (client-facing); `internal` with `S3_ENDPOINT`. */
  endpoint: SigningEndpoint;
  /** When set, the storage answers with `Content-Disposition: attachment; filename="…"`. */
  downloadFilename?: string;
}
