import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createQueueTestContext,
  type QueueTestContext,
} from '../src/test/queue-test.helper';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../src/test/storage-test.helper';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { ProcessingQueueUnavailableError } from '../src/videos/processing/video-processing.errors';
import { VideoProcessingQueue } from '../src/videos/processing/video-processing.queue';

interface DraftBody {
  id: string;
  public_id: string;
  upload: { parts: { part_number: number; url: string }[] };
}

interface ErrorBody {
  error: string;
  message: string | string[];
}

type PartRef = { part_number: number; etag: string };

const ONE_MIB = 1048576;

describe('POST /videos/{public_id}/upload/complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storageCtx: StorageTestContext;
  let queueCtx: QueueTestContext;
  let ownerToken: string;
  let otherToken: string;
  let draft: DraftBody;
  let validPart: PartRef;

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
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storageCtx.clearBucket();
    await queueCtx.clearQueue();
    throttlerStorage.storage.clear();
    ownerToken = await registerConfirmAndLogin('owner@example.com');
    otherToken = await registerConfirmAndLogin('other@example.com');

    draft = await createDraft(ONE_MIB);
    validPart = await putPart(draft, ONE_MIB);
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

  async function createDraft(sizeBytes: number): Promise<DraftBody> {
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

  /** PUTs part 1 straight to the storage and returns its reference. */
  async function putPart(target: DraftBody, size: number): Promise<PartRef> {
    const res = await fetch(target.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(size, 1)),
    });
    expect(res.status).toBe(200);
    return { part_number: 1, etag: res.headers.get('etag')! };
  }

  const complete = (
    publicId: string,
    parts: PartRef[],
    token: string | null = ownerToken,
  ) => {
    const req = request(app.getHttpServer()).post(
      `/videos/${publicId}/upload/complete`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send({ parts });
  };

  const findVideo = (id: string) => videoRepository.findOneBy({ id });

  describe('Conclusão bem-sucedida', () => {
    it('conclui-upload-e-muda-para-processing', async () => {
      const res = await complete(draft.public_id, [validPart]).expect(202);

      expect(res.body).toEqual({
        id: draft.id,
        public_id: draft.public_id,
        status: 'processing',
      });
      await expect(findVideo(draft.id)).resolves.toMatchObject({
        status: VideoStatus.PROCESSING,
        upload_id: null,
        size_bytes: String(ONE_MIB),
      });

      const job = await queueCtx.queue.getJob(draft.id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: draft.id });
      expect(job?.opts.attempts).toBe(3);
      expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
    });
  });

  describe('Falhas de conclusão', () => {
    it('etag-invalido-retorna-400-e-mantem-draft', async () => {
      const res = await complete(draft.public_id, [
        { part_number: 1, etag: '"00000000000000000000000000000000"' },
      ]).expect(400);

      expect((res.body as ErrorBody).error).toBe('INVALID_UPLOAD_PARTS');
      const video = await findVideo(draft.id);
      expect(video?.status).toBe(VideoStatus.DRAFT);
      expect(video?.upload_id).toBeTruthy();
      await expect(queueCtx.queue.getJob(draft.id)).resolves.toBeUndefined();
    });

    it('tamanho-divergente-retorna-422-e-remove-objeto-e-registro', async () => {
      const short = await createDraft(ONE_MIB);
      const part = await putPart(short, ONE_MIB / 2);

      const res = await complete(short.public_id, [part]).expect(422);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_SIZE_MISMATCH');
      await expect(findVideo(short.id)).resolves.toBeNull();
      await expect(
        storageCtx.storage.headObject(`videos/${short.id}/source`),
      ).resolves.toBeNull();
    });

    it('fila-indisponivel-retorna-503-e-retry-conclui', async () => {
      jest
        .spyOn(app.get(VideoProcessingQueue), 'enqueue')
        .mockRejectedValueOnce(
          new ProcessingQueueUnavailableError(draft.id, {
            cause: new Error('Connection is closed'),
          }),
        );

      const failed = await complete(draft.public_id, [validPart]).expect(503);

      expect((failed.body as ErrorBody).error).toBe('QUEUE_UNAVAILABLE');
      await expect(findVideo(draft.id)).resolves.toMatchObject({
        status: VideoStatus.DRAFT,
        upload_id: null,
      });

      const retried = await complete(draft.public_id, [validPart]).expect(202);

      expect((retried.body as { status: string }).status).toBe('processing');
      await expect(queueCtx.queue.getJob(draft.id)).resolves.toBeDefined();
    });

    it('video-em-processing-retorna-409', async () => {
      await complete(draft.public_id, [validPart]).expect(202);

      const res = await complete(draft.public_id, [validPart]).expect(409);

      expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATE');
      await expect(queueCtx.queue.getJobCounts('waiting')).resolves.toEqual({
        waiting: 1,
      });
    });

    it('parts-vazio-retorna-400-validation-error', async () => {
      const res = await complete(draft.public_id, []).expect(400);

      const body = res.body as ErrorBody;
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(([] as string[]).concat(body.message).join(' ')).toContain(
        'parts',
      );
      await expect(findVideo(draft.id)).resolves.toMatchObject({
        status: VideoStatus.DRAFT,
      });
    });

    it('nao-dono-e-anonimo-sao-rejeitados', async () => {
      const foreign = await complete(
        draft.public_id,
        [validPart],
        otherToken,
      ).expect(404);
      expect((foreign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

      await complete(draft.public_id, [validPart], null).expect(401);

      const video = await findVideo(draft.id);
      expect(video?.status).toBe(VideoStatus.DRAFT);
      expect(video?.upload_id).toBeTruthy();
    });
  });
});
