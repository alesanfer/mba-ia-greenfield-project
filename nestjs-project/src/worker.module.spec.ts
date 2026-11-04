import { Test, type TestingModule } from '@nestjs/testing';
import { VideoProcessor } from './videos/processing/video.processor';
import { VideosController } from './videos/videos.controller';
import { VideosService } from './videos/videos.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('should compile and provide the VideoProcessor', () => {
    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
  });

  it('should not pull the HTTP layer (VideosController / VideosService) into the graph', () => {
    expect(() => module.get(VideosController, { strict: false })).toThrow();
    expect(() => module.get(VideosService, { strict: false })).toThrow();
  });
});
