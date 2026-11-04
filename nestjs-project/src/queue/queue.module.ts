import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/**
 * Shared BullMQ connection. Imported once by each process entrypoint
 * (`AppModule` for the API, `WorkerModule` for the video worker).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.host, port: queue.port },
        // `bull-test` under Jest keeps tests away from the worker's `bull:*` keys.
        prefix: queue.prefix,
      }),
    }),
  ],
})
export class QueueModule {}
