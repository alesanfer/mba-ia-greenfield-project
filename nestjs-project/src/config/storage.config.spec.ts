import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';
import storageConfig from './storage.config';

const ENV_KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  'REDIS_HOST',
  'REDIS_PORT',
  'QUEUE_PREFIX',
] as const;

const loadConfigs = async (
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): Promise<{
  storage: ConfigType<typeof storageConfig>;
  queue: ConfigType<typeof queueConfig>;
}> => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [storageConfig, queueConfig],
      }),
    ],
  }).compile();

  const storage = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  const queue = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return { storage, queue };
};

// Captured at module load, before any test mutates process.env.
const original = { ...process.env };

describe('test environment overrides (src/test/setup-test-env.ts)', () => {
  it('should point storage and queue to the test bucket, internal host and test prefix', () => {
    expect(original.S3_BUCKET).toBe('streamtube-videos-test');
    expect(original.S3_PUBLIC_ENDPOINT).toBe('http://storage:9000');
    expect(original.QUEUE_PREFIX).toBe('bull-test');
  });
});

describe('storageConfig / queueConfig', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('should map every S3_* variable into the storage namespace', async () => {
    const { storage } = await loadConfigs({
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'sa-east-1',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret-key',
      S3_BUCKET: 'my-bucket',
    });

    expect(storage).toEqual({
      endpoint: 'http://storage:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'sa-east-1',
      accessKey: 'access',
      secretKey: 'secret-key',
      bucket: 'my-bucket',
    });
  });

  it('should parse REDIS_PORT as a number and read host and prefix', async () => {
    const { queue } = await loadConfigs({
      REDIS_HOST: 'redis',
      REDIS_PORT: '6380',
      QUEUE_PREFIX: 'bull-test',
    });

    expect(queue).toEqual({ host: 'redis', port: 6380, prefix: 'bull-test' });
    expect(typeof queue.port).toBe('number');
  });

  it('should default the queue prefix to bull when QUEUE_PREFIX is absent', async () => {
    const { queue } = await loadConfigs({
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
    });

    expect(queue.prefix).toBe('bull');
  });
});
