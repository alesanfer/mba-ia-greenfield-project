import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const PG_ERRORS = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;

const expectPgError = async (
  promise: Promise<unknown>,
  code: string,
): Promise<void> => {
  const error: unknown = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(QueryFailedError);
  expect((error as QueryFailedError & { code?: string }).code).toBe(code);
};

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'My trip',
      original_filename: 'my-trip.mp4',
      mime_type: 'video/mp4',
      declared_size_bytes: '10737418240',
      source_key: `videos/${id}/source`,
      upload_id: 'upload-id',
      ...overrides,
    });
  }

  it('should default status to draft and leave processing columns null', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.size_bytes).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should keep bigint sizes above 2^31 without precision loss', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: '10737418239' }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.declared_size_bytes).toBe('10737418240');
    expect(found.size_bytes).toBe('10737418239');
  });

  it('should reject a duplicated public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expectPgError(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
      PG_ERRORS.UNIQUE_VIOLATION,
    );
  });

  it('should reject a status outside the video_status enum', async () => {
    const channel = await createChannel();

    await expectPgError(
      videoRepository.save(
        buildVideo(channel.id, { status: 'published' as VideoStatus }),
      ),
      PG_ERRORS.INVALID_TEXT_REPRESENTATION,
    );
  });

  it('should require an existing channel', async () => {
    await expectPgError(
      videoRepository.save(buildVideo(randomUUID())),
      PG_ERRORS.FOREIGN_KEY_VIOLATION,
    );
  });

  it('should remove the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    const other = await createChannel();
    await videoRepository.save([
      buildVideo(channel.id),
      buildVideo(channel.id),
      buildVideo(other.id),
    ]);

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
    await expect(
      videoRepository.countBy({ channel_id: other.id }),
    ).resolves.toBe(1);
  });

  it('should round-trip metadata as jsonb', async () => {
    const channel = await createChannel();
    const metadata = {
      format: { format_name: 'mov,mp4,m4a', bit_rate: '1205000', tags: {} },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          r_frame_rate: '30/1',
        },
        { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
      ],
    };

    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
  });

  it('should load the owning channel and the inverse videos relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const video = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    const withVideos = await channelRepository.findOneOrFail({
      where: { id: channel.id },
      relations: { videos: true },
    });

    expect(video.channel.id).toBe(channel.id);
    expect(withVideos.videos.map((v) => v.id)).toEqual([saved.id]);
  });
});
