/**
 * The storage rejected the parts list of a multipart upload (wrong ETag,
 * wrong order or unknown upload). Callers map it to their own domain error.
 */
export class StorageInvalidPartsError extends Error {
  constructor(
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(`Storage rejected the multipart upload parts: ${code}`, options);
    this.name = 'StorageInvalidPartsError';
  }
}
