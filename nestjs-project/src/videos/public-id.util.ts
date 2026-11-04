import { randomBytes } from 'crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 11;

// Largest multiple of 62 that fits in a byte (62 * 4 = 248). Bytes at or above
// it are discarded so every character is equally likely (no modulo bias).
const UNBIASED_BYTE_LIMIT = 256 - (256 % ALPHABET.length);

/** Short, URL-safe base62 public id (11 chars ≈ 65 bits of entropy). */
export function generatePublicId(): string {
  let id = '';
  while (id.length < PUBLIC_ID_LENGTH) {
    for (const byte of randomBytes(PUBLIC_ID_LENGTH)) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === PUBLIC_ID_LENGTH) break;
    }
  }
  return id;
}
