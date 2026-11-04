import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint of the video-worker container: a Nest application context
 * without HTTP listeners. It runs until the container is stopped; shutdown
 * hooks let BullMQ finish/close the worker cleanly on SIGTERM.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'Worker');
}
void bootstrap();
