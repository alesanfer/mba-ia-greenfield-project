import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { QueueModule } from '../../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingQueue } from './video-processing.queue';

// Metadata key set by `@Processor()` (`@nestjs/bullmq` → bull.constants).
const PROCESSOR_METADATA = 'bullmq:processor_metadata';

describe('QueueModule + VideoProcessingModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        DiscoveryModule,
        QueueModule,
        VideoProcessingModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should compile and expose the VideoProcessingQueue producer', () => {
    expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
  });

  it('should register the video-processing queue on the configured prefix', () => {
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.opts.prefix).toBe('bull-test');
  });

  it('should not register any @Processor consumer', () => {
    const reflector = module.get(Reflector);
    const processors = module
      .get(DiscoveryService)
      .getProviders()
      .filter(
        (wrapper) =>
          wrapper.metatype &&
          reflector.get(PROCESSOR_METADATA, wrapper.metatype) !== undefined,
      );

    expect(processors).toHaveLength(0);
  });
});
