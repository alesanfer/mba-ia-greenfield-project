import { randomBytes } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createStorageTestContext,
  type StorageTestContext,
} from '../src/test/storage-test.helper';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface ErrorBody {
  error: string;
  message: string | string[];
}

const messages = (body: unknown): string =>
  ([] as string[]).concat((body as ErrorBody).message).join(' ');

interface CreateVideoBody {
  id: string;
  public_id: string;
  title: string;
  status: string;
  upload: {
    part_size: number;
    part_count: number;
    parts: { part_number: number; url: string }[];
    expires_at: string;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_HOUR_MS = 3600 * 1000;

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storageCtx: StorageTestContext;
  let accessToken: string;
  let channel: Channel;

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
  });

  afterAll(async () => {
    await storageCtx.clearBucket();
    await storageCtx.module.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storageCtx.clearBucket();
    throttlerStorage.storage.clear();
    accessToken = await registerConfirmAndLogin('uploader@example.com');
    channel = await dataSource
      .getRepository(Channel)
      .findOneOrFail({ where: { user: { email: 'uploader@example.com' } } });
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

  const postVideo = (body: object, token: string | null = accessToken) => {
    const req = request(app.getHttpServer()).post('/videos');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  describe('Pré-cadastro do rascunho', () => {
    it('cria-draft-com-titulo-default-e-urls-de-parte', async () => {
      const before = Date.now();

      const res = await postVideo({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: 262144000,
      }).expect(201);

      const body = res.body as CreateVideoBody;
      expect(body.id).toMatch(UUID);
      expect(body.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(body.title).toBe('aula');
      expect(body.status).toBe('draft');
      expect(body.upload.part_size).toBe(104857600);
      expect(body.upload.part_count).toBe(3);
      expect(body.upload.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      for (const part of body.upload.parts) expect(part.url).toBeTruthy();
      const expiresAt = Date.parse(body.upload.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(before + ONE_HOUR_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + ONE_HOUR_MS);

      const video = await videoRepository.findOneByOrFail({ id: body.id });
      expect(video).toMatchObject({
        status: VideoStatus.DRAFT,
        channel_id: channel.id,
        declared_size_bytes: '262144000',
        source_key: `videos/${body.id}/source`,
        original_filename: 'aula.mp4',
        mime_type: 'video/mp4',
      });
      expect(video.upload_id).toBeTruthy();
    });

    it('cria-draft-com-titulo-informado', async () => {
      const res = await postVideo({
        filename: 'aula.webm',
        mime_type: 'video/webm',
        size_bytes: 1048576,
        title: 'Introdução ao NestJS',
      }).expect(201);

      const body = res.body as CreateVideoBody;
      expect(body.title).toBe('Introdução ao NestJS');
      expect(body.upload.part_count).toBe(1);
    });

    it('urls-de-parte-no-host-publico-e-aceitam-put', async () => {
      const res = await postVideo({
        filename: 'clip.mp4',
        mime_type: 'video/mp4',
        size_bytes: 1024,
      }).expect(201);

      const body = res.body as CreateVideoBody;
      const publicOrigin = new URL(storageCtx.config.publicEndpoint).origin;
      for (const part of body.upload.parts) {
        expect(new URL(part.url).origin).toBe(publicOrigin);
      }

      // Straight to the storage with the test's own HTTP client, not the API.
      const put = await fetch(body.upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(1024)),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();
    });
  });

  describe('Rejeições', () => {
    it('rejeita-mime-fora-da-allowlist', async () => {
      const res = await postVideo({
        filename: 'aula.mkv',
        mime_type: 'video/x-matroska',
        size_bytes: 1024,
      }).expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      expect(Array.isArray((res.body as ErrorBody).message)).toBe(true);
      expect(messages(res.body)).toContain('mime_type');
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejeita-tamanho-acima-de-10-gib', async () => {
      const res = await postVideo({
        filename: 'big.mp4',
        mime_type: 'video/mp4',
        size_bytes: 10737418241,
      }).expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      expect(messages(res.body)).toContain('size_bytes');
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('exige-autenticacao', async () => {
      await postVideo(
        { filename: 'aula.mp4', mime_type: 'video/mp4', size_bytes: 1024 },
        null,
      ).expect(401);

      await expect(videoRepository.count()).resolves.toBe(0);
    });
  });
});
