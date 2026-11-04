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

interface VideoBody {
  public_id: string;
  status: string;
  thumbnail_url: string | null;
  processing_error: string | null;
  [key: string]: unknown;
}

interface ErrorBody {
  error: string;
  message: string | string[];
}

const INTERNAL_KEYS = [
  'upload_id',
  'source_key',
  'channel_id',
  'metadata',
  'declared_size_bytes',
];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe('GET /videos/{public_id} (e2e)', () => {
  let app: INestApplication<App>;
  let workerModule: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storageCtx: StorageTestContext;
  let queueCtx: QueueTestContext;
  let ownerToken: string;
  let otherToken: string;
  let draft: DraftBody;

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
  });

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
        filename: 'aula.mp4',
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

  const getVideo = (publicId: string, token: string | null = ownerToken) => {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  const expectNoInternalKeys = (body: VideoBody) => {
    for (const key of INTERNAL_KEYS) expect(body).not.toHaveProperty(key);
  };

  describe('Leitura pelo dono', () => {
    it('draft-retorna-200-com-metadados-nulos', async () => {
      draft = await createDraft();

      const res = await getVideo(draft.public_id).expect(200);

      const body = res.body as VideoBody;
      expect(body).toMatchObject({
        id: draft.id,
        public_id: draft.public_id,
        title: 'aula',
        status: 'draft',
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
        thumbnail_url: null,
        size_bytes: null,
        duration_seconds: null,
        width: null,
        height: null,
        video_codec: null,
        audio_codec: null,
        processing_error: null,
      });
      expect(body.created_at).toMatch(ISO_8601);
      expect(body.updated_at).toMatch(ISO_8601);
      expectNoInternalKeys(body);
    });

    it('ready-retorna-metadados-e-thumbnail-acessivel', async () => {
      const fixture = loadMediaFixture('MP4_360P');
      const ready = await readyVideo(fixture);

      const res = await getVideo(ready.public_id).expect(200);

      const body = res.body as VideoBody;
      expect(body).toMatchObject({
        status: 'ready',
        width: 640,
        height: 360,
        video_codec: 'h264',
        size_bytes: fixture.length,
      });
      expect(body.duration_seconds).toBeGreaterThan(0);
      expectNoInternalKeys(body);
      expect(body.thumbnail_url).not.toBeNull();
      expect(new URL(body.thumbnail_url!).origin).toBe(
        new URL(process.env.S3_PUBLIC_ENDPOINT!).origin,
      );

      const thumbnail = await fetch(body.thumbnail_url!);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
      const bytes = Buffer.from(await thumbnail.arrayBuffer());
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }, 60_000);

    it('failed-retorna-processing-error', async () => {
      draft = await createDraft();
      await videoRepository.update(
        { id: draft.id },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          processing_error: 'NO_VIDEO_STREAM: no video stream found',
        },
      );

      const res = await getVideo(draft.public_id).expect(200);

      const body = res.body as VideoBody;
      expect(body.status).toBe('failed');
      expect(body.processing_error).toMatch(/^NO_VIDEO_STREAM/);
      expect(body.thumbnail_url).toBeNull();
    });
  });

  describe('Acesso negado', () => {
    beforeEach(async () => {
      draft = await createDraft();
    });

    it('outro-canal-retorna-404-igual-a-inexistente', async () => {
      const foreign = await getVideo(draft.public_id, otherToken).expect(404);
      const missing = await getVideo('ZZZZZZZZZZZ').expect(404);

      const foreignBody = foreign.body as ErrorBody;
      expect(foreignBody.error).toBe('VIDEO_NOT_FOUND');
      expect((missing.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      expect((missing.body as ErrorBody).message).toEqual(foreignBody.message);
    });

    it('exige-autenticacao', async () => {
      await getVideo(draft.public_id, null).expect(401);
    });
  });
});
