import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { loadMediaFixture } from '../src/test/media-fixtures.helper';
import {
  createQueueTestContext,
  type QueueTestContext,
} from '../src/test/queue-test.helper';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../src/test/storage-test.helper';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  VideoProcessor,
  type ProcessVideoJob,
} from '../src/videos/processing/video.processor';
import { WorkerModule } from '../src/worker.module';

interface DraftBody {
  id: string;
  public_id: string;
  upload: { parts: { part_number: number; url: string }[] };
}

interface SignedUrlBody {
  url: string;
  expires_at: string;
}

interface ErrorBody {
  error: string;
  message: string | string[];
}

const ONE_MIB = 1048576;
const ORIGINAL_FILENAME = 'minha-aula.mp4';
const EXPIRY_TOLERANCE_MS = 10_000;

describe('GET /videos/{public_id}/stream e /download (e2e)', () => {
  let app: INestApplication<App>;
  let workerModule: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storageCtx: StorageTestContext;
  let queueCtx: QueueTestContext;
  let ownerToken: string;
  let otherToken: string;
  let ready: DraftBody;
  let fixture: Buffer;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    // Compiled but not initialised: no BullMQ worker is started, the test
    // drives `VideoProcessor.process` in-process (TD-16).
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageCtx = await createStorageTestContext();
    queueCtx = await createQueueTestContext();
    fixture = loadMediaFixture('MP4_OVER_1MIB');
    expect(fixture.length).toBeGreaterThan(ONE_MIB);
  });

  afterAll(async () => {
    await storageCtx.clearBucket();
    await queueCtx.clearQueue();
    await storageCtx.module.close();
    await queueCtx.module.close();
    await workerModule.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storageCtx.clearBucket();
    await queueCtx.clearQueue();
    throttlerStorage.storage.clear();
    ownerToken = await registerConfirmAndLogin('owner@example.com');
    otherToken = await registerConfirmAndLogin('other@example.com');
    ready = await readyVideo(fixture);
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    let token = '';
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        token = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token })
      .expect(204);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  async function createDraft(sizeBytes = 1024): Promise<DraftBody> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: ORIGINAL_FILENAME,
        mime_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    return res.body as DraftBody;
  }

  /** Draft → upload (single part) → complete → processor run → `ready`. */
  async function readyVideo(fixture: Buffer): Promise<DraftBody> {
    const created = await createDraft(fixture.length);
    const put = await fetch(created.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(fixture),
    });
    expect(put.status).toBe(200);
    await request(app.getHttpServer())
      .post(`/videos/${created.public_id}/upload/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ parts: [{ part_number: 1, etag: put.headers.get('etag') }] })
      .expect(202);

    await workerModule.get(VideoProcessor).process({
      id: created.id,
      data: { videoId: created.id },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as ProcessVideoJob);
    return created;
  }

  const getSigned = (
    publicId: string,
    kind: 'stream' | 'download',
    token: string | null = ownerToken,
  ) => {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}/${kind}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  const expectSignedUrl = (body: SignedUrlBody, ttlSeconds: number) => {
    const expected = Date.now() + ttlSeconds * 1000;
    expect(
      Math.abs(new Date(body.expires_at).getTime() - expected),
    ).toBeLessThan(EXPIRY_TOLERANCE_MS);
    // Bytes come from the storage, never from the API.
    expect(new URL(body.url).origin).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT!).origin,
    );
  };

  describe('Vídeo ready do dono', () => {
    it('stream-retorna-url-com-ttl-de-1h-e-suporta-range', async () => {
      const res = await getSigned(ready.public_id, 'stream').expect(200);

      const body = res.body as SignedUrlBody;
      expectSignedUrl(body, 3600);

      const partial = await fetch(body.url, {
        headers: { Range: `bytes=0-${ONE_MIB - 1}` },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(
        `bytes 0-${ONE_MIB - 1}/${fixture.length}`,
      );
      expect((await partial.arrayBuffer()).byteLength).toBe(ONE_MIB);
    });

    it('download-retorna-url-com-ttl-de-15min-e-content-disposition', async () => {
      const res = await getSigned(ready.public_id, 'download').expect(200);

      const body = res.body as SignedUrlBody;
      expectSignedUrl(body, 900);

      const file = await fetch(body.url);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toBe(
        `attachment; filename="${ORIGINAL_FILENAME}"`,
      );
      expect((await file.arrayBuffer()).byteLength).toBe(fixture.length);
    });
  });

  describe('Estados inválidos e acesso negado', () => {
    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'stream-e-download-fora-de-ready-retornam-409 (%s)',
      async (status) => {
        await videoRepository.update({ id: ready.id }, { status });

        for (const kind of ['stream', 'download'] as const) {
          const res = await getSigned(ready.public_id, kind).expect(409);
          expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATE');
        }
      },
    );

    it('outro-canal-retorna-404', async () => {
      for (const kind of ['stream', 'download'] as const) {
        const res = await getSigned(ready.public_id, kind, otherToken).expect(
          404,
        );
        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      }
    });

    it('exige-autenticacao', async () => {
      await getSigned(ready.public_id, 'stream', null).expect(401);
      await getSigned(ready.public_id, 'download', null).expect(401);
    });
  });
});
