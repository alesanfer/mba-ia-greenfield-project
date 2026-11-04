// Loaded by Jest `setupFiles` BEFORE `dotenv/config`. dotenv never overrides
// variables that are already set, so these values win over `.env` in every
// test process (unit, integration and E2E — the E2E suite boots the full
// AppModule, which reads storage/queue settings straight from the env).
//
// - S3_BUCKET: dedicated test bucket, provisioned by the `storage-init` service.
// - S3_PUBLIC_ENDPOINT: SigV4 signs the host, so presigned URLs must already
//   carry a host reachable from inside the test container (Compose service name).
// - QUEUE_PREFIX: isolates test queues from the `video-worker` consuming `bull:*`.
process.env.S3_BUCKET = 'streamtube-videos-test';
process.env.S3_PUBLIC_ENDPOINT = 'http://storage:9000';
process.env.QUEUE_PREFIX = 'bull-test';
