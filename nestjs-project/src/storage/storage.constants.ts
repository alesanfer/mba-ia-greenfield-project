export const STORAGE_CLIENTS = {
  INTERNAL: Symbol('STORAGE_INTERNAL_S3_CLIENT'),
  PUBLIC: Symbol('STORAGE_PUBLIC_S3_CLIENT'),
} as const;

/** S3 error codes returned by CompleteMultipartUpload when the parts list is unusable. */
export const INVALID_PARTS_ERROR_CODES = [
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
] as const;
