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
  createStorageTestContext,
  type StorageTestContext,
} from '../src/test/storage-test.helper';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface DraftBody {
  id: string;
  public_id: string;
  upload: { parts: { part_number: number; url: string }[] };
}

interface UploadStatusBody {
  part_size: number;
  part_count: number;
  uploaded_parts: { part_number: number; etag: string; size: number }[];
  parts: { part_number: number; url: string }[];
  expires_at: string;
}

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

const PART_SIZE = 104857600;
const ONE_HOUR_MS = 3600 * 1000;

describe('GET / DELETE /videos/{public_id}/upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storageCtx: StorageTestContext;
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
    ownerToken = await registerConfirmAndLogin('owner@example.com');
    otherToken = await registerConfirmAndLogin('other@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'aula.mp4',
        mime_type: 'video/mp4',
        size_bytes: 2 * PART_SIZE + 1024,
      })
      .expect(201);
    draft = res.body as DraftBody;
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

  const getUpload = (publicId: string, token: string | null) => {
    const req = request(app.getHttpServer()).get(`/videos/${publicId}/upload`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const deleteUpload = (publicId: string, token: string) =>
    request(app.getHttpServer())
      .delete(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${token}`);

  describe('Retomada do upload', () => {
    it('retomada-lista-partes-enviadas-e-reassina-faltantes', async () => {
      const put = await fetch(draft.upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(PART_SIZE, 7)),
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag');
      expect(etag).toBeTruthy();
      const before = Date.now();

      const res = await getUpload(draft.public_id, ownerToken).expect(200);

      const body = res.body as UploadStatusBody;
      expect(body.part_size).toBe(PART_SIZE);
      expect(body.part_count).toBe(3);
      expect(body.uploaded_parts).toEqual([
        { part_number: 1, etag, size: PART_SIZE },
      ]);
      expect(body.parts.map((p) => p.part_number)).toEqual([2, 3]);
      const publicOrigin = new URL(storageCtx.config.publicEndpoint).origin;
      for (const part of body.parts) {
        expect(new URL(part.url).origin).toBe(publicOrigin);
      }
      const expiresAt = Date.parse(body.expires_at);
      expect(expiresAt).toBeGreaterThanOrEqual(before + ONE_HOUR_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + ONE_HOUR_MS);
    }, 60_000);

    it('retomada-de-video-de-outro-canal-retorna-404', async () => {
      const foreign = await getUpload(draft.public_id, otherToken).expect(404);
      const missing = await getUpload('ZZZZZZZZZZZ', ownerToken).expect(404);

      expect((foreign.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      expect(missing.body).toEqual(foreign.body);
    });

    it('retomada-de-video-em-processing-retorna-409', async () => {
      await videoRepository.update(
        { id: draft.id },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );

      const res = await getUpload(draft.public_id, ownerToken).expect(409);

      expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATE');
    });

    it('retomada-exige-autenticacao', async () => {
      await getUpload(draft.public_id, null).expect(401);
    });
  });

  describe('Cancelamento do upload', () => {
    it('cancelamento-remove-draft-e-aborta-multipart', async () => {
      const issuedUrl = draft.upload.parts[1].url;

      const res = await deleteUpload(draft.public_id, ownerToken).expect(204);

      expect(res.text).toBe('');
      await expect(videoRepository.countBy({ id: draft.id })).resolves.toBe(0);

      const gone = await request(app.getHttpServer())
        .get(`/videos/${draft.public_id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect((gone.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

      const put = await fetch(issuedUrl, {
        method: 'PUT',
        body: new Uint8Array(1024),
      });
      expect(put.status).toBeGreaterThanOrEqual(400);
      await expect(
        storageCtx.storage.headObject(`videos/${draft.id}/source`),
      ).resolves.toBeNull();
    });

    it('cancelamento-de-video-ready-retorna-409', async () => {
      await videoRepository.update(
        { id: draft.id },
        { status: VideoStatus.READY, upload_id: null },
      );

      const res = await deleteUpload(draft.public_id, ownerToken).expect(409);

      expect((res.body as ErrorBody).error).toBe('INVALID_VIDEO_STATE');
      await expect(
        videoRepository.findOneByOrFail({ id: draft.id }),
      ).resolves.toMatchObject({ status: VideoStatus.READY });
    });

    it('cancelamento-de-video-de-outro-canal-retorna-404', async () => {
      const res = await deleteUpload(draft.public_id, otherToken).expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      await expect(videoRepository.countBy({ id: draft.id })).resolves.toBe(1);
    });
  });
});
