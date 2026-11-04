import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  const SAMPLES = 2000;

  it('should return 11 base62 characters', () => {
    for (let i = 0; i < SAMPLES; i++) {
      expect(generatePublicId()).toMatch(/^[0-9A-Za-z]{11}$/);
    }
    expect(PUBLIC_ID_LENGTH).toBe(11);
  });

  it('should return distinct values on successive calls', () => {
    const ids = new Set(
      Array.from({ length: SAMPLES }, () => generatePublicId()),
    );

    expect(ids.size).toBe(SAMPLES);
  });

  it('should draw characters from the whole alphabet', () => {
    const seen = new Set(
      Array.from({ length: SAMPLES }, () => generatePublicId()).join(''),
    );

    expect(seen.size).toBe(62);
  });
});
