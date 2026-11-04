import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
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
import {
  VideoProcessor,
  type ProcessVideoJob,
} from '../src/videos/processing/video.processor';
import { WorkerModule } from '../src/worker.module';

interface DraftBody {
  id: string;
  public_id: string;
  status: string;
  upload: {
    part_size: number;
    part_count: number;
    parts: { part_number: number; url: string }[];
  };
}

interface VideoBody {
  status: string;
  size_bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  thumbnail_url: string | null;
}

interface SignedUrlBody {
  url: string;
  expires_at: string;
}

const ONE_MIB = 1048576;
const FILENAME = 'fluxo-completo.mp4';

/**
 * Upload → processing → streaming/download through HTTP only, against the
 * real Postgres, Redis, MinIO and FFmpeg. The job published by the API is
 * read from the queue and run by an in-process `VideoProcessor` (TD-16).
 */
describe('Fluxo de vídeo: upload → processamento → stream/download (e2e)', () => {
  let app: INestApplication<App>;
  let workerModule: TestingModule;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageCtx: StorageTestContext;
  let queueCtx: QueueTestContext;

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

    // Compiled but not initialised: no BullMQ worker competes for the job.
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageCtx = await createStorageTestContext();
    queueCtx = await createQueueTestContext();
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
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

  it('leva um vídeo de draft até ready e o entrega por stream e download', async () => {
    const fixture = loadMediaFixture('MP4_OVER_1MIB');
    const token = await registerConfirmAndLogin('creator@example.com');
    const auth = { Authorization: `Bearer ${token}` };
    const http = () => request(app.getHttpServer());

    // 1. Pre-register the draft and receive the presigned part URLs.
    const created = await http()
      .post('/videos')
      .set(auth)
      .send({
        filename: FILENAME,
        mime_type: 'video/mp4',
        size_bytes: fixture.length,
      })
      .expect(201);
    const draft = created.body as DraftBody;
    expect(draft.status).toBe('draft');

    // 2. PUT every part straight to the storage.
    const parts: { part_number: number; etag: string }[] = [];
    for (const { part_number, url } of draft.upload.parts) {
      const start = (part_number - 1) * draft.upload.part_size;
      const chunk = fixture.subarray(start, start + draft.upload.part_size);
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(chunk),
      });
      expect(put.status).toBe(200);
      parts.push({ part_number, etag: put.headers.get('etag')! });
    }

    // 3. Complete the upload: the API publishes the processing job.
    const completed = await http()
      .post(`/videos/${draft.public_id}/upload/complete`)
      .set(auth)
      .send({ parts })
      .expect(202);
    expect((completed.body as { status: string }).status).toBe('processing');
    const processing = await http()
      .get(`/videos/${draft.public_id}`)
      .set(auth)
      .expect(200);
    expect((processing.body as VideoBody).status).toBe('processing');

    // 4. The worker consumes the job published by the API.
    const job = await queueCtx.queue.getJob(draft.id);
    expect(job).toBeDefined();
    await workerModule
      .get(VideoProcessor)
      .process(job as unknown as ProcessVideoJob);

    // 5. The owner sees the video ready, with metadata and thumbnail.
    const read = await http()
      .get(`/videos/${draft.public_id}`)
      .set(auth)
      .expect(200);
    const video = read.body as VideoBody;
    expect(video).toMatchObject({
      status: 'ready',
      size_bytes: fixture.length,
      width: 640,
      height: 360,
      video_codec: 'h264',
    });
    expect(video.duration_seconds).toBeGreaterThan(0);
    const thumbnail = await fetch(video.thumbnail_url!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');

    // 6. Progressive playback: a 1 MiB range, no full download.
    const stream = await http()
      .get(`/videos/${draft.public_id}/stream`)
      .set(auth)
      .expect(200);
    const partial = await fetch((stream.body as SignedUrlBody).url, {
      headers: { Range: `bytes=0-${ONE_MIB - 1}` },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(
      `bytes 0-${ONE_MIB - 1}/${fixture.length}`,
    );
    const head = Buffer.from(await partial.arrayBuffer());
    expect(head.equals(fixture.subarray(0, ONE_MIB))).toBe(true);

    // 7. Download: the whole original file under its original name.
    const download = await http()
      .get(`/videos/${draft.public_id}/download`)
      .set(auth)
      .expect(200);
    const file = await fetch((download.body as SignedUrlBody).url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      `attachment; filename="${FILENAME}"`,
    );
    expect(Buffer.from(await file.arrayBuffer()).equals(fixture)).toBe(true);
  }, 60_000);
});
