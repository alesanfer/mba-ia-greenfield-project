import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './channels/entities/channel.entity';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import { MediaModule } from './media/media.module';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos/processing/video-processing.constants';
import { VideoProcessor } from './videos/processing/video.processor';

/**
 * Root module of the video-worker process (`src/worker.ts`). No HTTP, no
 * controllers: it only consumes the `video-processing` queue. It shares
 * entities, config and infrastructure modules with the API, but never imports
 * `VideosModule` (TD-02).
 */
@Module({
  imports: [
    // Same namespaces and Joi schema as the API: a misconfigured env fails
    // fast in both processes.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
        queueConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Channel and User are not used by the worker; they close the relation
    // graph (Video → Channel → User) so TypeORM can build the metadata.
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
