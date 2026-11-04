import type { ValidationResult } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://storage:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const validateWithout = (key: keyof typeof requiredEnv) => {
  const env: Record<string, string> = { ...requiredEnv };
  delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

const validate = (
  env: Record<string, string>,
): ValidationResult<Record<string, string>> =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

const validValue = (env: Record<string, string>): Record<string, string> => {
  const result = validate(env);
  if (result.error) throw result.error;
  return result.value;
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    expect(validValue({}).SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue keys', () => {
  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKET',
    'REDIS_HOST',
    'REDIS_PORT',
  ] as const)('should reject the environment when %s is missing', (key) => {
    const { error } = validateWithout(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'storage' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject REDIS_PORT that is not a valid port', () => {
    const { error } = validate({ REDIS_PORT: 'not-a-port' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });

  it('should default QUEUE_PREFIX to bull when not set', () => {
    expect(validValue({}).QUEUE_PREFIX).toBe('bull');
  });
});
