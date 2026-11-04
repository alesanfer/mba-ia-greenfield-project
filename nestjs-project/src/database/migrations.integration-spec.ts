import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793789166550 } from './migrations/1793789166550-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];

// Enum types outlive `DROP TABLE … CASCADE`; leaving them behind makes the
// migrations that create them fail with "type already exists".
const MANAGED_ENUM_TYPES = ['video_status', 'verification_tokens_type_enum'];

const listTables = async (dataSource: DataSource): Promise<string[]> => {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [MANAGED_TABLES],
  );
  return rows.map((r) => r.table_name);
};

const listEnumTypes = async (dataSource: DataSource): Promise<string[]> => {
  const rows = await dataSource.query<{ typname: string }[]>(
    `SELECT typname FROM pg_type
     WHERE typtype = 'e' AND typname = ANY($1::text[])
     ORDER BY typname`,
    [MANAGED_ENUM_TYPES],
  );
  return rows.map((r) => r.typname);
};

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1793789166550,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential on purpose: concurrent CASCADE drops can deadlock.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${type}"`);
    }
  });

  afterAll(async () => {
    // The revert test undoes the last migration. Re-apply so the shared DB is
    // fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every table and enum type', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations.map((m) => m.name)).toEqual([
      'CreateUsersAndChannels1775687773260',
      'CreateAuthTokens1777579850478',
      'CreateVideos1793789166550',
    ]);
    expect(await listTables(dataSource)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
    expect(await listEnumTypes(dataSource)).toEqual([
      'verification_tokens_type_enum',
      'video_status',
    ]);
  });

  it('should revert CreateVideos removing videos and video_status only', async () => {
    await dataSource.undoLastMigration();

    expect(await listTables(dataSource)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
    expect(await listEnumTypes(dataSource)).toEqual([
      'verification_tokens_type_enum',
    ]);
  });
});
