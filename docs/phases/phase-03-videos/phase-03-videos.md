---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-03T20:19:43-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-03T20:19:43-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-03T20:15:55-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-03T19:25:25-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB sem impacto na performance (direto ao object storage, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload), o processamento automático em segundo plano via fila e worker (extração de duração e metadados e geração de thumbnail a partir de um frame do vídeo), uma URL única por vídeo sem conflito, reprodução via streaming sem download completo e download do vídeo pelo usuário — com storage, fila e worker reais subindo no Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose

**Description:** Instala as bibliotecas da fase, cria os namespaces de configuração validados por Joi e sobe Redis + object storage (com provisionamento de buckets) no `compose.yaml`, deixando a infraestrutura real disponível para os SIs seguintes e para os testes.

**Technical actions:**

1. Instalar no container `nestjs-api`: `@nestjs/bullmq bullmq ioredis @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`; `ioredis` explícito porque é peer opcional no `bullmq@6`, per `library-refs.md`)
2. Criar `src/config/storage.config.ts` (`registerAs('storage', …)` com `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `bucket`) e `src/config/queue.config.ts` (`registerAs('queue', …)` com `host`, `port`); adicionar `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT` ao schema Joi em `src/config/env.validation.ts` e ao `.env.example` (hosts internos = nomes de serviço Compose: `storage`, `redis`) (per `phase-03-videos/TD-04`; convenções herdadas de `phase-01-configuracao-base/TD-02`, `phase-01-configuracao-base/TD-03`)
3. Adicionar ao `compose.yaml` o serviço `redis` (`redis:8.8`, healthcheck `redis-cli ping`) e o serviço `storage` (`cgr.dev/chainguard/minio` fixado por digest `@sha256:…`, credenciais via env, porta `9000`, volume nomeado, healthcheck) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
4. Adicionar ao `compose.yaml` o serviço one-shot `storage-init` (`cgr.dev/chainguard/minio-client` fixado por digest) que cria de forma idempotente o bucket privado `S3_BUCKET` e o bucket de testes `streamtube-videos-test`; `nestjs-api` passa a depender de `redis` (healthy), `storage` (healthy) e `storage-init` (completed) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-16`)
5. Adicionar `ffmpeg` ao `Dockerfile.dev` (`apt install -y ffmpeg`) — a mesma imagem serve a API (testes do worker in-process) e o futuro container `video-worker` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves S3/Redis) | Unit: falha com chave ausente ou inválida | `src/config/env.validation.integration-spec.ts` |
| `storageConfig` / `queueConfig` | Unit: factories leem as variáveis e aplicam tipos (porta numérica) | `src/config/storage.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, `redis` e `storage` com status `running`/`healthy`, e `storage-init` termina com exit code 0
- `docker compose exec redis redis-cli ping` responde `PONG`
- Após `storage-init`, os buckets `S3_BUCKET` e `streamtube-videos-test` existem e não permitem leitura anônima
- Reexecutar `storage-init` com os buckets já criados termina com exit code 0 (idempotente)
- A aplicação não inicia quando qualquer uma das chaves `S3_*` ou `REDIS_*` está ausente do ambiente
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` executam com sucesso

---

### SI-03.2 — StorageModule: cliente S3, multipart e URLs pré-assinadas

**Description:** Encapsula todo acesso ao object storage em um `StorageService` reutilizável pela API e pelo worker, com dois clientes S3 (I/O interno e assinatura pública) e as operações de multipart, objeto e assinatura que os SIs de upload, processamento e entrega consomem.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `src/storage/storage.service.ts` — dois `S3Client` singleton: `internalClient` (`endpoint = storage.endpoint`, faz I/O) e `publicClient` (`endpoint = storage.publicEndpoint`, só assina); ambos com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-04`; configuração S3-compatível per `library-refs.md` → `@aws-sdk/client-s3`)
2. Implementar operações de multipart em `StorageService`: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, ttl)` (via `publicClient`), `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-06`)
3. Implementar operações de objeto e leitura: `headObject(key)` (retorna `ContentLength` ou `null` quando inexistente), `putObject(key, body, contentType)`, `deleteObject(key)`, `presignGetObject(key, ttl, { endpoint: 'public' | 'internal', downloadFilename? })` — `downloadFilename` vira `ResponseContentDisposition: attachment; filename="…"` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-15`; `expiresIn` sempre explícito, per `library-refs.md` → `@aws-sdk/s3-request-presigner`)
4. Traduzir erros do SDK em erros de domínio de storage: `InvalidPart`/`InvalidPartOrder`/`NoSuchUpload` no `CompleteMultipartUpload` → `StorageInvalidPartsError` (consumido em SI-03.7 para `INVALID_UPLOAD_PARTS`); `NotFound` no `HeadObject` → `null`
5. Criar helper de teste `src/test/storage-test.helper.ts` que monta o `StorageModule` apontando para o bucket `streamtube-videos-test` e limpa os objetos entre testes (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` (multipart) | Integration (MinIO real): cria multipart, envia 2 partes via `PUT` nas URLs pré-assinadas, `listParts` retorna as partes com ETag, `completeMultipartUpload` gera o objeto, `abortMultipartUpload` invalida o upload | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (leitura/objeto) | Integration (MinIO real): `presignGetObject` com header `Range` responde `206`; com `downloadFilename` responde `Content-Disposition: attachment`; `headObject` de chave inexistente retorna `null`; `completeMultipartUpload` com ETag errado lança `StorageInvalidPartsError` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — storage no Compose, config `storage` e libs instaladas

**Acceptance criteria:**

- Uma parte enviada com `PUT` direto na URL pré-assinada de `UploadPart` (sem headers de checksum) é aceita pelo storage e devolve `ETag`
- Concluir o multipart com as partes enviadas produz um objeto cujo tamanho reportado por `HeadObject` é a soma das partes
- Concluir o multipart com um `ETag` divergente falha com `StorageInvalidPartsError` e nenhum objeto é criado
- `GET` com `Range: bytes=0-1023` na URL pré-assinada de leitura responde `206 Partial Content` com 1024 bytes
- A URL pré-assinada de download responde com `Content-Disposition: attachment; filename="<nome informado>"`
- URLs assinadas com `endpoint: 'public'` usam o host de `S3_PUBLIC_ENDPOINT`; URLs com `endpoint: 'internal'` usam o host de `S3_ENDPOINT`
- Acesso anônimo (sem assinatura) a qualquer objeto do bucket é negado

---

### SI-03.3 — Entidade Video, migration e gerador de public_id

**Description:** Cria a tabela `videos` ligada ao canal, com o ciclo de status e as colunas de storage e metadados definidas no Data Model, mais o gerador do ID público curto que forma a URL única.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com todas as colunas do `### Data Model → Video` (enum `video_status` com `'draft'`, `'processing'`, `'ready'`, `'failed'`, default `'draft'`; `public_id` `varchar(11)` unique; `metadata` `jsonb`; `size_bytes`/`declared_size_bytes` `bigint`) e `@ManyToOne(() => Channel)` via `channel_id` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-09`, `phase-03-videos/TD-14` Revision)
2. Adicionar o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos` em `src/channels/entities/channel.entity.ts` (relação nos dois lados, convenção de entidades)
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` — cria o tipo enum `video_status`, a tabela `videos`, o índice único em `public_id`, o índice em `channel_id` e a FK `channel_id → channels.id ON DELETE CASCADE`; `down` remove tabela e tipo
4. Criar `src/videos/public-id.util.ts` — `generatePublicId(): string` com `crypto.randomBytes` mapeado para o alfabeto base62 (`0-9A-Za-z`) em 11 caracteres, sem dependência nova (per `phase-03-videos/TD-09`)
5. Incluir `Video` na lista de entidades do helper `src/test/create-test-data-source.ts` e em `cleanAllTables` (ordem respeitando a FK)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, default `status = 'draft'`, enum rejeita valor fora da lista, FK exige canal existente, cascade ao remover canal, `metadata` jsonb round-trip | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: 11 caracteres, somente `[0-9A-Za-z]`, valores distintos em chamadas sucessivas | `src/videos/public-id.util.spec.ts` |
| Migrations | Integration: `CreateVideos` aplica e reverte sobre o schema atual | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 — config e ambiente (independente de storage/fila, mas ordenado após a infra da fase)

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `video_status`; `npm run migration:revert` remove ambos sem afetar `users`/`channels`
- Inserir dois vídeos com o mesmo `public_id` — o segundo falha por violação de unicidade
- Inserir um vídeo sem `status` — persiste com `status = 'draft'`
- Inserir um vídeo com `channel_id` inexistente — falha por violação de FK
- Remover um canal remove os vídeos dele (cascade)
- `generatePublicId()` sempre retorna 11 caracteres do alfabeto `[0-9A-Za-z]`

---

### SI-03.4 — Fila video-processing: conexão BullMQ e producer

**Description:** Conecta a aplicação ao Redis via `@nestjs/bullmq`, registra a fila `video-processing` e entrega o producer `VideoProcessingQueue` com as opções de job do `### Events/Messages` (dedup por `videoId`, retentativas com backoff).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory })` lendo `REDIS_HOST`/`REDIS_PORT`; importado pelo `AppModule` e, depois, pelo `WorkerModule` (per `phase-03-videos/TD-01`; padrão `forRootAsync` + `ConfigType` herdado de `phase-01-configuracao-base/TD-03`)
2. Criar `src/videos/processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, tipo `ProcessVideoJobData = { videoId: string }` e `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`) (per `phase-03-videos/TD-13`, `### Events/Messages`)
3. Criar `src/videos/processing/video-processing.queue.ts` — `VideoProcessingQueue` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)` e `enqueue(videoId)` → `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })` (per `phase-03-videos/TD-07`)
4. Criar `src/videos/processing/video-processing.module.ts` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` + provider/export `VideoProcessingQueue` (sem `@Processor` — consumer fica só no `WorkerModule`, per `phase-03-videos/TD-02`)
5. Criar helper de teste `src/test/queue-test.helper.ts` — registra a fila com `prefix: 'bull-test'` e esvazia a fila (`obliterate`) entre testes (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` + `VideoProcessingModule` | Unit: compilation test | `src/videos/processing/video-processing.module.spec.ts` |
| `VideoProcessingQueue` | Integration (Redis real): `enqueue` cria job `process-video` com `jobId = videoId`, payload `{ videoId }`, `attempts = 3` e backoff exponencial; segundo `enqueue` com o mesmo id não cria job novo | `src/videos/processing/video-processing.queue.integration-spec.ts` |

**Dependencies:** SI-03.1 — Redis no Compose, config `queue` e libs instaladas

**Acceptance criteria:**

- `enqueue(videoId)` deixa na fila `video-processing` exatamente um job `process-video` com id igual ao `videoId` e payload `{ "videoId": "<uuid>" }`
- O job enfileirado tem `attempts = 3` e backoff `exponential`
- Chamar `enqueue` duas vezes com o mesmo `videoId` enquanto o primeiro job existe mantém um único job na fila
- Com o Redis indisponível, `enqueue` rejeita com erro (não fica pendurado indefinidamente) — insumo para o `QUEUE_UNAVAILABLE` de SI-03.7
- O `AppModule` da API não registra nenhum consumer da fila `video-processing`

---

### SI-03.5 — Endpoint POST /videos: pré-cadastro do rascunho e início do upload

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated — o vídeo é criado no canal do usuário autenticado (per `### Authorization Matrix`)

**Description:** Ao iniciar o upload, pré-cadastra o vídeo como `draft`, abre o S3 Multipart Upload e devolve as URLs pré-assinadas de todas as partes, para o cliente enviar o arquivo direto ao storage sem passar pela API.

**Technical actions:**

1. Adicionar `findByUserId(userId): Promise<Channel | null>` ao `ChannelsService` (`src/channels/channels.service.ts`) e exportá-lo pelo `ChannelsModule` — o domínio de canal resolve "qual é o canal deste usuário"; `VideosService` não consulta `channels` diretamente (single responsibility)
2. Criar `src/videos/videos.constants.ts` (constantes de `### Data Model → Upload limits`) e `src/videos/dto/create-video.dto.ts` — `filename` (`@IsString @Length(1,255)`), `mime_type` (`@IsIn(ALLOWED_VIDEO_MIME_TYPES)`), `size_bytes` (`@IsInt @Min(1) @Max(MAX_VIDEO_SIZE_BYTES)`), `title` opcional (`@IsOptional @IsString @Length(1,255)`) (per `phase-03-videos/TD-08`, `### API Contracts → Validation Rules — Upload`)
3. Adicionar ao `src/common/exceptions/domain.exception.ts` os códigos do `### Error Catalog` desta fase: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `InvalidVideoStateException` (`INVALID_VIDEO_STATE`, 409), `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 400), `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422), `QueueUnavailableException` (`QUEUE_UNAVAILABLE`, 503) (envelope herdado per `phase-02-auth/TD-07`)
4. Criar `src/videos/videos.service.ts` — `createDraft(userId, dto)`: resolve o canal via `ChannelsService`; gera `id` (`crypto.randomUUID()`) e `source_key = videos/{id}/source`; chama `createMultipartUpload`; insere o vídeo `draft` com `upload_id`, `title` (default = `filename` sem extensão), `public_id` via `generatePublicId()` com retry em violação de unicidade (até 5 tentativas); se o insert falhar, chama `abortMultipartUpload`; calcula `part_count = ceil(size_bytes / UPLOAD_PART_SIZE_BYTES)` e assina cada parte com `UPLOAD_PART_URL_TTL_SECONDS` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-09`, `phase-03-videos/TD-12` Revision)
5. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`, `@Post()` → 201 com o shape de `### API Contracts → POST /videos`, decorators `@nestjs/swagger` conforme `openapi-docs-nestjs/TD-01`) e `src/videos/videos.module.ts` (importa `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `VideoProcessingModule`); registrar `VideosModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosService.createDraft` | Unit (mocks de repo/storage/channels): título default sem extensão, `part_count` para tamanhos exatos e não múltiplos de 100 MiB, retry de `public_id` em colisão, `abortMultipartUpload` chamado quando o insert falha | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration (DB + MinIO reais): persiste o `draft` com `upload_id` e `source_key`, e as URLs de parte aceitam `PUT` | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.3 (entidade e `generatePublicId`), SI-03.4 (`VideoProcessingModule` importado pelo módulo)

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", mime_type: "video/mp4", size_bytes: 262144000 }` retorna `201` com `status: "draft"`, `title: "aula"`, `public_id` de 11 caracteres e `upload.part_count = 3` com 3 URLs
- `POST /videos` com `title` informado retorna `201` com esse `title`
- Após `POST /videos`, existe um registro em `videos` com `status = 'draft'`, `channel_id` = canal do usuário autenticado, `declared_size_bytes` = valor enviado e `upload_id` não nulo
- `POST /videos` com `mime_type: "video/x-matroska"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- As URLs de `upload.parts` apontam para o host de `S3_PUBLIC_ENDPOINT` e nenhum byte do vídeo é enviado à API

---

### SI-03.6 — Endpoints de retomada e cancelamento do upload

**Route:** GET /videos/{public_id}/upload, DELETE /videos/{public_id}/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner — não dono recebe `404 VIDEO_NOT_FOUND`; exige `status = 'draft'` (per `### Authorization Matrix`)

**Description:** Permite retomar um upload interrompido (lista as partes já recebidas e reassina as faltantes) e cancelá-lo (aborta o multipart e remove o rascunho), cobrindo os casos de borda de upload falho e cancelado.

**Technical actions:**

1. Adicionar a `VideosService` o helper `findOwnedByPublicId(userId, publicId): Promise<Video>` — busca por `public_id` restrita ao canal do usuário; lança `VideoNotFoundException` quando inexistente ou de outro canal (per `phase-03-videos/TD-11`; regra de posse no service, convenção de camadas)
2. Implementar `VideosService.getUploadStatus(userId, publicId)` — exige `draft` com `upload_id` (senão `InvalidVideoStateException`); chama `listParts`, devolve `uploaded_parts` e assina apenas os `part_number` faltantes de `1..part_count` com `UPLOAD_PART_URL_TTL_SECONDS` (per `phase-03-videos/TD-06`)
3. Implementar `VideosService.cancelUpload(userId, publicId)` — exige `draft` (senão `InvalidVideoStateException`); chama `abortMultipartUpload` quando `upload_id` presente, `deleteObject(source_key)` quando `headObject` encontra o objeto, e remove o registro (per `phase-03-videos/TD-06` Revision 2026-11-03)
4. Adicionar a `VideosController` `@Get(':public_id/upload')` (200, shape de `### API Contracts → GET /videos/{public_id}/upload`) e `@Delete(':public_id/upload')` (`@HttpCode(204)`), com decorators `@nestjs/swagger`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getUploadStatus` / `cancelUpload` / `findOwnedByPublicId` | Unit (mocks): vídeo de outro canal → `VideoNotFoundException`; status ≠ `draft` → `InvalidVideoStateException`; `upload_id` nulo → retomada rejeitada e cancelamento só remove objeto + registro; partes faltantes calculadas corretamente | `src/videos/videos.service.spec.ts` |
| `VideosService.getUploadStatus` / `cancelUpload` | Integration (DB + MinIO reais): após enviar 1 de 3 partes, a retomada lista 1 parte recebida e devolve 2 URLs; após o cancelamento o registro some e o `UploadId` deixa de aceitar partes | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — rascunho, `VideosService` e `VideosController` existentes

**Acceptance criteria:**

- `GET /videos/{public_id}/upload` após enviar 1 de 3 partes retorna `200` com `uploaded_parts` contendo `part_number: 1` e `parts` com as URLs das partes 2 e 3
- `GET /videos/{public_id}/upload` para um vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/{public_id}/upload` para um vídeo em `processing` retorna `409` com `error: "INVALID_VIDEO_STATE"`
- `DELETE /videos/{public_id}/upload` para um `draft` do dono retorna `204`; em seguida o vídeo não existe no banco e `GET /videos/{public_id}` retorna `404`
- Após o cancelamento, um `PUT` em uma URL de parte emitida antes falha (o multipart foi abortado)
- `DELETE /videos/{public_id}/upload` para um vídeo em `ready` retorna `409` com `error: "INVALID_VIDEO_STATE"`

---

### SI-03.7 — Endpoint POST /videos/{public_id}/upload/complete: conclusão do upload e disparo do processamento

**Route:** POST /videos/{public_id}/upload/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner — não dono recebe `404 VIDEO_NOT_FOUND`; exige `status = 'draft'` (per `### Authorization Matrix`)

**Description:** Conclui o multipart, confere o tamanho real do objeto e faz a transição `draft → processing` publicando o job `process-video`, de forma idempotente quando o enfileiramento falha.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts` (`@IsArray @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => UploadedPartDto)`), `UploadedPartDto` com `part_number` (`@IsInt @Min(1)`) e `etag` (`@IsString @IsNotEmpty`) (per `### API Contracts → Validation Rules — Upload`)
2. Implementar `VideosService.completeUpload(userId, publicId, dto)` — passo 1: `findOwnedByPublicId` + exige `draft`; passo 2: se `upload_id` presente, `completeMultipartUpload` (`StorageInvalidPartsError` → `InvalidUploadPartsException`) e persiste `upload_id = null` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-06`)
3. Continuar `completeUpload` — passo 3: `headObject(source_key)`; tamanho ≠ `declared_size_bytes` → `deleteObject`, remove o registro e lança `UploadSizeMismatchException`; passo 4: grava `size_bytes` e `status = 'processing'` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-12`)
4. Continuar `completeUpload` — passo 5: `videoProcessingQueue.enqueue(id)` com timeout curto; em falha, reverte `status` para `draft` (mantendo `upload_id = null`) e lança `QueueUnavailableException` — uma nova chamada pula o passo 2 e retoma do passo 3 (per `phase-03-videos/TD-07`)
5. Adicionar a `VideosController` `@Post(':public_id/upload/complete')` com `@HttpCode(202)`, resposta `{ id, public_id, status: "processing" }` e decorators `@nestjs/swagger`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mocks de storage/fila/repo): partes inválidas → `InvalidUploadPartsException`; tamanho divergente → objeto e registro removidos + `UploadSizeMismatchException`; falha no `enqueue` → status volta a `draft` + `QueueUnavailableException`; repetição com `upload_id` nulo não chama `completeMultipartUpload` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): após enviar todas as partes, conclui o multipart, grava `size_bytes`, muda para `processing` e deixa o job `process-video` com `jobId = id` na fila | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedByPublicId` e controller; SI-03.4 — producer da fila

**Acceptance criteria:**

- `POST /videos/{public_id}/upload/complete` com os `part_number`/`etag` de todas as partes enviadas retorna `202` com `status: "processing"`; o vídeo fica com `status = 'processing'`, `upload_id = null` e `size_bytes` = tamanho real do objeto
- Após a conclusão bem-sucedida, a fila `video-processing` contém o job `process-video` com payload `{ "videoId": "<id do vídeo>" }`
- `POST /videos/{public_id}/upload/complete` com um `etag` que não corresponde à parte enviada retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo continua `draft`
- Quando o arquivo enviado tem tamanho diferente de `declared_size_bytes`, retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`; o objeto e o registro do vídeo deixam de existir
- Com o Redis indisponível, retorna `503` com `error: "QUEUE_UNAVAILABLE"` e o vídeo volta a `draft`; repetir a chamada com o Redis disponível retorna `202`
- `POST /videos/{public_id}/upload/complete` para um vídeo em `processing` retorna `409` com `error: "INVALID_VIDEO_STATE"`
- `POST /videos/{public_id}/upload/complete` com `parts: []` retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.8 — MediaModule: wrapper de ffprobe e ffmpeg

**Description:** Fornece ao worker a extração de duração/metadados (ffprobe) e de um frame JPEG redimensionado (ffmpeg) a partir de uma URL HTTP, com classificação de erros em permanentes e transitórios.

**Technical actions:**

1. Criar `src/media/media.module.ts` + `src/media/media-probe.service.ts` — `probe(inputUrl)` executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.execFile` com timeout; retorna `ProbeResult { durationSeconds, width, height, videoCodec, audioCodec, sizeBytes, raw }` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-14` Revision 2026-11-03 — metadados)
2. Classificar falhas do ffprobe em `src/media/media.errors.ts`: sem stream de vídeo → `NoVideoStreamError`; saída ≠ 0 por conteúdo inválido → `ProbeFailedError` (ambos permanentes); timeout e erro de conexão HTTP → `MediaTransientError` (consumido por SI-03.9 para `UnrecoverableError` vs retry, per `phase-03-videos/TD-13`)
3. Criar `src/media/thumbnail.service.ts` — `thumbnailTimestamp(durationSeconds)` = 10% da duração (piso 0 s) e `extractThumbnail(inputUrl, atSeconds): Promise<Buffer>` executando `ffmpeg -ss <t> -i <url> -frames:v 1 -vf "scale='min(1280,iw)':-2" -f image2pipe -vcodec mjpeg pipe:1` (per `phase-03-videos/TD-14` Revision 2026-11-03 — thumbnail; leitura via HTTP Range per `phase-03-videos/TD-15`)
4. Criar helper de teste `src/test/media-fixtures.helper.ts` — gera fixtures curtas com `ffmpeg -f lavfi` (`testsrc` 1920×1080 MP4 H.264 + AAC; WebM VP9 sem áudio; arquivo só de áudio; arquivo de bytes aleatórios) e as serve ao FFmpeg pelo bucket de testes via URL pré-assinada (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration (ffprobe + MinIO reais): MP4 → duração ≈ duração gerada, 1920×1080, `h264`/`aac`; WebM sem áudio → `audioCodec = null`; só áudio → `NoVideoStreamError`; bytes aleatórios → `ProbeFailedError` | `src/media/media-probe.service.integration-spec.ts` |
| `ThumbnailService` | Integration (ffmpeg + MinIO reais): retorna JPEG válido (assinatura `FF D8`) com largura 1280 e proporção mantida | `src/media/thumbnail.service.integration-spec.ts` |
| `thumbnailTimestamp` + parse do ffprobe | Unit: 10% da duração, piso 0 para duração 0/ausente; mapeamento de streams para `ProbeResult` | `src/media/media-probe.service.spec.ts` |

**Dependencies:** SI-03.1 (FFmpeg na imagem) e SI-03.2 (URLs pré-assinadas para servir as fixtures)

**Acceptance criteria:**

- Para um MP4 H.264/AAC 1920×1080 de 4 s, `probe` retorna `durationSeconds` ≈ 4, `width = 1920`, `height = 1080`, `videoCodec = "h264"`, `audioCodec = "aac"`
- Para um WebM sem áudio, `probe` retorna `audioCodec = null`
- Para um arquivo só de áudio, `probe` rejeita com `NoVideoStreamError`; para bytes aleatórios, com `ProbeFailedError`
- `extractThumbnail` de um vídeo 1920×1080 retorna um JPEG de 1280×720; de um vídeo de 640×360, um JPEG de 640×360 (sem ampliar)
- `thumbnailTimestamp(40)` = 4 e `thumbnailTimestamp(0)` = 0
- O processamento lê o arquivo pela URL HTTP sem gravá-lo inteiro em disco local

---

### SI-03.9 — Worker de vídeo: VideoProcessor, entrypoint standalone e container video-worker

**Description:** Consome a fila `video-processing` em um processo/container separado da API, extrai metadados, gera e grava o thumbnail e conclui o ciclo `processing → ready | failed` no banco.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` + `WorkerHost`; `process(job)`: carrega o vídeo e ignora se não estiver em `processing` (idempotência); gera URL `presignGetObject(source_key, PROCESSING_URL_TTL_SECONDS, { endpoint: 'internal' })`; chama `MediaProbeService.probe` e `ThumbnailService.extractThumbnail`; `putObject('videos/{id}/thumbnail.jpg', jpeg, 'image/jpeg')`; grava `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `metadata`, `thumbnail_key` e `status = 'ready'` com update condicional `WHERE status = 'processing'` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-14`, `phase-03-videos/TD-15`, `### Events/Messages`)
2. Tratar falhas no `VideoProcessor`: `NoVideoStreamError`/`ProbeFailedError` → `UnrecoverableError` com motivo `NO_VIDEO_STREAM`/`PROBE_FAILED`; demais erros propagam para retry; `@OnWorkerEvent('failed')` grava `status = 'failed'` + `processing_error` quando o erro é irrecuperável ou `job.attemptsMade >= job.opts.attempts` (motivo `PROCESSING_FAILED`), com log do erro e sem relançar (per `phase-03-videos/TD-13`; regra de handlers de background do projeto)
3. Criar `src/worker.module.ts` — importa `ConfigModule` (mesmo schema Joi), `TypeOrmModule.forRootAsync` (mesmo `databaseConfig`), `QueueModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, `StorageModule`, `MediaModule`, `TypeOrmModule.forFeature([Video])` e declara `VideoProcessor` (não importa `VideosModule`/controllers) (per `phase-03-videos/TD-02`; config herdada per `phase-01-configuracao-base/TD-03`, `phase-01-configuracao-base/TD-04`)
4. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`; adicionar scripts `start:worker` (`nest start --watch --entryFile worker`) e `start:worker:prod` (`node dist/worker`) ao `package.json` (per `library-refs.md` → `@nestjs/bullmq`)
5. Adicionar ao `compose.yaml` o serviço `video-worker` — mesmo build `Dockerfile.dev` e volume do `nestjs-api`, `command` executando `npm run start:worker`, `depends_on` `db`/`redis`/`storage` (healthy) e `storage-init` (completed) (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit (mocks de repo/storage/media): vídeo fora de `processing` é ignorado; erro de conteúdo vira `UnrecoverableError`; erro transitório propaga; handler `failed` grava `failed` só na última tentativa ou em erro irrecuperável | `src/videos/processing/video.processor.spec.ts` |
| `VideoProcessor` | Integration (DB + MinIO + ffmpeg reais, `process` chamado in-process): vídeo válido termina `ready` com metadados e `thumbnail.jpg` no bucket; arquivo só de áudio termina `failed` com `processing_error` iniciando em `NO_VIDEO_STREAM` | `src/videos/processing/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test (sem `VideosController` no grafo) | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.4 (fila e constantes), SI-03.7 (vídeos chegam a `processing`), SI-03.8 (MediaModule)

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` com status `running`, separado do `nestjs-api`
- Um vídeo MP4 válido enfileirado em `processing` chega a `status = 'ready'` com `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `metadata` e `thumbnail_key = videos/{id}/thumbnail.jpg` preenchidos
- O objeto `videos/{id}/thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`
- Um arquivo sem stream de vídeo chega a `status = 'failed'` com `processing_error` iniciando em `NO_VIDEO_STREAM`, sem novas tentativas
- Uma falha transitória que persiste nas 3 tentativas leva o vídeo a `failed` com `processing_error` iniciando em `PROCESSING_FAILED`; se a falha cessar antes, o vídeo termina `ready`
- Reprocessar um job de um vídeo já `ready` não altera o registro
- Com o worker parado, os jobs permanecem na fila e são processados quando o `video-worker` volta a subir

---

### SI-03.10 — Endpoint GET /videos/{public_id}: leitura do vídeo pelo dono

**Route:** GET /videos/{public_id}
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner — não dono recebe `404 VIDEO_NOT_FOUND`; qualquer status (per `### Authorization Matrix`)

**Description:** Expõe ao dono o estado do vídeo (status, metadados, `public_id` e thumbnail) para acompanhar o processamento, sem listagem — que fica para a Fase 04.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` — classe de resposta com os campos de `### API Contracts → GET /videos/{public_id}` (`snake_case`, `size_bytes`/`duration_seconds` como `number`), decorada para `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)
2. Implementar `VideosService.getOwnedVideo(userId, publicId)` — usa `findOwnedByPublicId`; gera `thumbnail_url` via `presignGetObject(thumbnail_key, THUMBNAIL_URL_TTL_SECONDS, { endpoint: 'public' })` quando `thumbnail_key` não é nulo; não expõe `upload_id`, `source_key`, `declared_size_bytes`, `channel_id` nem `metadata` (per `phase-03-videos/TD-11` Revision 2026-11-03)
3. Adicionar a `VideosController` `@Get(':public_id')` retornando `VideoResponseDto` (200)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit (mocks): `thumbnail_url` nulo sem `thumbnail_key`; URL assinada quando há thumbnail; campos internos ausentes da resposta | `src/videos/videos.service.spec.ts` |
| `VideosService.getOwnedVideo` | Integration (DB + MinIO reais): vídeo `ready` retorna `thumbnail_url` que responde `200` com `image/jpeg` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (`findOwnedByPublicId`); SI-03.9 para o caso com thumbnail

**Acceptance criteria:**

- `GET /videos/{public_id}` de um `draft` do dono retorna `200` com `status: "draft"`, `thumbnail_url: null` e campos de metadados nulos
- `GET /videos/{public_id}` de um vídeo `ready` retorna `200` com `duration_seconds`, `width`, `height`, `video_codec` preenchidos e `thumbnail_url` cuja requisição `GET` responde `200` com `Content-Type: image/jpeg`
- `GET /videos/{public_id}` de um vídeo `failed` retorna `200` com `processing_error` preenchido
- `GET /videos/{public_id}` de um vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`, igual a um `public_id` inexistente
- A resposta não contém `upload_id`, `source_key`, `channel_id` nem `metadata`
- `GET /videos/{public_id}` sem `Authorization` retorna `401`

---

### SI-03.11 — Endpoints de streaming e download

**Route:** GET /videos/{public_id}/stream, GET /videos/{public_id}/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner — não dono recebe `404 VIDEO_NOT_FOUND`; exige `status = 'ready'` (per `### Authorization Matrix`)

**Description:** Entrega ao dono URLs pré-assinadas do arquivo original: uma para reprodução progressiva (o storage atende `Range`/`206`) e outra que força download com o nome original do arquivo.

**Technical actions:**

1. Implementar `VideosService.getStreamUrl(userId, publicId)` — `findOwnedByPublicId` + exige `ready` (senão `InvalidVideoStateException`); retorna `{ url, expires_at }` via `presignGetObject(source_key, STREAM_URL_TTL_SECONDS, { endpoint: 'public' })` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
2. Implementar `VideosService.getDownloadUrl(userId, publicId)` — mesmas regras; `presignGetObject(source_key, DOWNLOAD_URL_TTL_SECONDS, { endpoint: 'public', downloadFilename: original_filename })` (per `phase-03-videos/TD-10`)
3. Criar `src/videos/dto/signed-url-response.dto.ts` (`url`, `expires_at`) e adicionar a `VideosController` `@Get(':public_id/stream')` e `@Get(':public_id/download')` (200), com decorators `@nestjs/swagger`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` / `getDownloadUrl` | Unit (mocks): status ≠ `ready` → `InvalidVideoStateException`; TTLs de 3600 s e 900 s; `downloadFilename` = `original_filename` | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamUrl` / `getDownloadUrl` | Integration (DB + MinIO reais): `GET` com `Range` na URL de stream responde `206`; URL de download responde `Content-Disposition: attachment; filename="<original_filename>"` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (`findOwnedByPublicId`), SI-03.9 (vídeos chegam a `ready`)

**Acceptance criteria:**

- `GET /videos/{public_id}/stream` de um vídeo `ready` do dono retorna `200` com `url` e `expires_at` ≈ agora + 1h
- Uma requisição `GET` na `url` de stream com `Range: bytes=0-1048575` responde `206 Partial Content` com `Content-Range` e 1 MiB de corpo — reprodução sem download completo
- `GET /videos/{public_id}/download` de um vídeo `ready` retorna `200` com `expires_at` ≈ agora + 15 min; a `url` responde `200` com `Content-Disposition: attachment; filename="<original_filename>"` e o arquivo completo
- `GET /videos/{public_id}/stream` ou `/download` de um vídeo em `draft`, `processing` ou `failed` retorna `409` com `error: "INVALID_VIDEO_STATE"`
- `GET /videos/{public_id}/stream` de um vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Os bytes do vídeo são servidos pelo storage (host de `S3_PUBLIC_ENDPOINT`), nunca pela API

---

### SI-03.12 — Fluxo completo de ponta a ponta e documentação da fase

**Description:** Prova o fluxo upload → processamento → streaming/download de ponta a ponta com a infraestrutura real e atualiza OpenAPI, CLAUDE.md e diagrama para refletir o estado real do código.

**Technical actions:**

1. Criar `test/videos-flow.e2e-spec.ts` — com a app completa (configuração global de `main.ts` reproduzida) e um `VideoProcessor` in-process: registra e confirma usuário, faz login, `POST /videos`, envia as partes de uma fixture via `PUT` nas URLs, `POST …/upload/complete`, processa o job, `GET /videos/{public_id}` até `ready`, `GET …/stream` com `Range` → `206` e `GET …/download` (per `phase-03-videos/TD-16`)
2. Regerar `nestjs-project/openapi.json` via `npm run openapi:export` com os 7 endpoints de vídeo (per `openapi-docs-nestjs/TD-02`)
3. Atualizar `nestjs-project/CLAUDE.md` — serviços `redis`, `storage`, `storage-init` e `video-worker`, checagens de prontidão (`redis-cli ping`, healthcheck do storage, `docker compose logs video-worker`), scripts `start:worker`, buckets de teste e a regra "API nunca recebe bytes de vídeo; worker nunca é importado pelo `AppModule`"
4. Atualizar o `CLAUDE.md` da raiz (seção de vídeos: módulos `videos`/`storage`/`media`/`queue`, endpoints, fila e worker, storage) e `docs/diagrams/software-arch.mermaid` (Message Queue `TBD` → `Redis (BullMQ)`), coerentes com o código

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo upload → processamento → stream/download | E2E (supertest + Postgres, Redis, MinIO e FFmpeg reais) | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.9, SI-03.10, SI-03.11 — todos os endpoints e o worker implementados

**Acceptance criteria:**

- Um usuário confirmado consegue, só com chamadas HTTP e `PUT`s nas URLs pré-assinadas, levar um vídeo de `draft` até `ready` e obter `206` ao ler um trecho pela URL de stream
- O `nestjs-project/openapi.json` versionado contém os 7 endpoints `/videos` com os shapes de `### API Contracts`
- Todo arquivo, serviço, script e endpoint citado no `CLAUDE.md` da raiz e no `nestjs-project/CLAUDE.md` existe no código
- O diagrama `software-arch.mermaid` não contém mais `TBD` para a fila

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (SI-03.3). Convenções de entidade do projeto: PK UUID, `@CreateDateColumn`/`@UpdateDateColumn`, nome de tabela explícito, colunas em `snake_case`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Identificador interno; compõe as chaves de storage (per `phase-03-videos/TD-05`) |
| public_id | varchar(11) | unique, not null | ID público base62 de 11 caracteres gerado com `crypto.randomBytes` no pré-cadastro; colisão → retry (per `phase-03-videos/TD-09`) |
| channel_id | uuid | FK → channels.id, not null, `ON DELETE CASCADE` | Canal dono do vídeo |
| title | varchar(255) | not null | Opcional no pré-cadastro; quando ausente, deriva do nome do arquivo sem extensão (per `phase-03-videos/TD-12` Revision 2026-11-03) |
| status | enum `video_status` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Ciclo de processamento; transições `draft→processing` (API) e `processing→ready\|failed` (worker) (per `phase-03-videos/TD-12`) |
| original_filename | varchar(255) | not null | Nome do arquivo informado pelo cliente no pré-cadastro; usado no `Content-Disposition` do download |
| mime_type | varchar(50) | not null | `video/mp4` ou `video/webm` (per `phase-03-videos/TD-08`) |
| declared_size_bytes | bigint | not null | Tamanho declarado no pré-cadastro, ≤ 10 GiB (per `phase-03-videos/TD-08`) |
| size_bytes | bigint | nullable | Tamanho real do objeto (`HeadObject`) gravado na conclusão do upload (per `phase-03-videos/TD-07`, `phase-03-videos/TD-14` Revision) |
| upload_id | varchar(1024) | nullable | `UploadId` do S3 Multipart Upload; preenchido no pré-cadastro, anulado após `CompleteMultipartUpload` (per `phase-03-videos/TD-06`) |
| source_key | varchar(255) | not null | `videos/{id}/source` (per `phase-03-videos/TD-05`) |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, preenchido pelo worker (per `phase-03-videos/TD-05`, `phase-03-videos/TD-14` Revision) |
| duration_seconds | numeric(10,3) | nullable | Duração extraída pelo ffprobe (per `phase-03-videos/TD-14` Revision) |
| width | integer | nullable | Largura do stream de vídeo |
| height | integer | nullable | Altura do stream de vídeo |
| video_codec | varchar(50) | nullable | `codec_name` do stream de vídeo |
| audio_codec | varchar(50) | nullable | `codec_name` do stream de áudio; null quando não há áudio |
| metadata | jsonb | nullable | Restante da saída do ffprobe (`format` + `streams`) (per `phase-03-videos/TD-14` Revision) |
| processing_error | text | nullable | Motivo da falha quando `status = 'failed'` (per `phase-03-videos/TD-13`) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, inverse side — campo `videos` adicionado à entidade `Channel`)
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK lookup

**Storage objects (bucket único privado `S3_BUCKET`, per `phase-03-videos/TD-05`):**

| Key | Producer | Content-Type | Notes |
|-----|----------|--------------|-------|
| `videos/{id}/source` | Cliente, via URLs pré-assinadas de `UploadPart` (per `phase-03-videos/TD-06`) | `mime_type` do vídeo | Arquivo original; nunca transcodificado (per `phase-03-videos/TD-08`) |
| `videos/{id}/thumbnail.jpg` | `VideoProcessor` (worker) | `image/jpeg` | Frame em 10% da duração (piso 0 s), largura máx. 1280px mantendo proporção (per `phase-03-videos/TD-14` Revision) |

**Upload limits (constantes de domínio, per `phase-03-videos/TD-06` e `phase-03-videos/TD-08`):**

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_VIDEO_SIZE_BYTES` | `10737418240` | 10 GiB (10 × 1024³) |
| `UPLOAD_PART_SIZE_BYTES` | `104857600` | 100 MiB fixo; última parte pode ser menor; `part_count = ceil(size / part_size)` (≤ 103 partes para 10 GiB; limite S3 = 10.000) |
| `ALLOWED_VIDEO_MIME_TYPES` | `video/mp4`, `video/webm` | Allowlist sem transcodificação |
| `UPLOAD_PART_URL_TTL_SECONDS` | `3600` | URLs de parte expiram em 1h; reassináveis via `GET /videos/{public_id}/upload` |
| `STREAM_URL_TTL_SECONDS` | `3600` | per `phase-03-videos/TD-10` |
| `DOWNLOAD_URL_TTL_SECONDS` | `900` | per `phase-03-videos/TD-10` |
| `THUMBNAIL_URL_TTL_SECONDS` | `3600` | Parâmetro do plano (alinhado ao TTL de stream); `phase-03-videos/TD-11` Revision define apenas que o thumbnail é servido por URL pré-assinada no `GET /videos/{public_id}` |
| `PROCESSING_URL_TTL_SECONDS` | `900` | Parâmetro do plano para a URL interna de curta duração que o worker passa ao FFmpeg (per `phase-03-videos/TD-15`) |

### API Contracts

Todas as rotas exigem `Authorization: Bearer <access_token>` (guard JWT global herdado, per `phase-02-auth/TD-02`) e operam somente sobre vídeos do canal do usuário autenticado (per `phase-03-videos/TD-11`). O path param `{public_id}` é o ID público de 11 caracteres — a URL única do vídeo (per `phase-03-videos/TD-09`). Respostas em `snake_case`, seguindo os contratos da Fase 02. Erros seguem o envelope `{ statusCode, error, message }` herdado (per `phase-02-auth/TD-07`). Bytes de vídeo nunca trafegam pela API: upload e leitura usam URLs pré-assinadas do storage (per `phase-03-videos/TD-06`, `phase-03-videos/TD-10`).

#### POST /videos (SI-03.5)

Pré-cadastra o vídeo como `draft`, inicia o S3 Multipart Upload e devolve as URLs pré-assinadas de todas as partes (per `phase-03-videos/TD-06`, `phase-03-videos/TD-12` Revision).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1..255 caracteres
- mime_type: string, required — `video/mp4` | `video/webm`
- size_bytes: integer, required — 1..10737418240
- title: string, optional — 1..255 caracteres; default = `filename` sem extensão

**Response 201:**
- id: string (uuid)
- public_id: string (11 caracteres base62)
- title: string
- status: `"draft"`
- upload: object
  - part_size: integer (bytes, `104857600`)
  - part_count: integer
  - parts: array of `{ part_number: integer, url: string }` — uma URL pré-assinada de `UploadPart` por parte, no host `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-04`)
  - expires_at: string (ISO-8601) — expiração das URLs de parte

**Error responses:**
- 400 VALIDATION_ERROR: body inválido (MIME fora da allowlist, `size_bytes` fora de 1..10 GiB, campos ausentes)
- 401: access token ausente ou inválido

---

#### GET /videos/{public_id}/upload (SI-03.6)

Retomada do upload: lista as partes já recebidas pelo storage (`ListParts`) e reassina apenas as faltantes (per `phase-03-videos/TD-06`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- part_size: integer
- part_count: integer
- uploaded_parts: array of `{ part_number: integer, etag: string, size: integer }`
- parts: array of `{ part_number: integer, url: string }` — somente as partes ainda não recebidas
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente ou de outro canal
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft` ou o multipart já foi concluído (`upload_id` nulo)
- 401: access token ausente ou inválido

---

#### POST /videos/{public_id}/upload/complete (SI-03.7)

Conclui o multipart, confere o tamanho real e dispara o processamento (per `phase-03-videos/TD-07`). Idempotente após falha de enfileiramento: se o multipart já foi concluído (`upload_id` nulo), pula `CompleteMultipartUpload` e só reconfere tamanho + reenfileira.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required, min 1 item — itens `{ part_number: integer ≥ 1, etag: string (não vazio) }`

**Response 202:**
- id: string (uuid)
- public_id: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: body inválido
- 400 INVALID_UPLOAD_PARTS: o storage rejeitou a lista de partes (parte ausente, ETag divergente, ordem inválida)
- 404 VIDEO_NOT_FOUND: `public_id` inexistente ou de outro canal
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`
- 422 UPLOAD_SIZE_MISMATCH: tamanho real do objeto difere de `declared_size_bytes` (objeto e rascunho são removidos)
- 503 QUEUE_UNAVAILABLE: falha ao publicar o job; status revertido para `draft` (o cliente pode repetir a chamada)
- 401: access token ausente ou inválido

---

#### DELETE /videos/{public_id}/upload (SI-03.6)

Cancela o upload: `AbortMultipartUpload` (quando `upload_id` presente), remove o objeto parcial/completo se existir e apaga o registro em `draft` (per `phase-03-videos/TD-06` Revision 2026-11-03).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente ou de outro canal
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`
- 401: access token ausente ou inválido

---

#### GET /videos/{public_id} (SI-03.10)

Leitura individual de um vídeo do próprio dono, em qualquer status, para acompanhar o processamento (per `phase-03-videos/TD-11` Revision 2026-11-03). Listagem fica para a Fase 04.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: `"draft"` | `"processing"` | `"ready"` | `"failed"`
- original_filename: string
- mime_type: string
- size_bytes: integer | null
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- thumbnail_url: string | null — URL pré-assinada de GET do thumbnail; null enquanto `thumbnail_key` for nulo
- processing_error: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente ou de outro canal
- 401: access token ausente ou inválido

---

#### GET /videos/{public_id}/stream (SI-03.11)

Devolve URL pré-assinada de `GetObject` do arquivo original; o storage atende `Range` com `206 Partial Content`, permitindo reprodução sem download completo (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — URL pré-assinada (TTL 3600 s), host `S3_PUBLIC_ENDPOINT`
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente ou de outro canal
- 409 INVALID_VIDEO_STATE: vídeo não está em `ready` (per `phase-03-videos/TD-11`)
- 401: access token ausente ou inválido

---

#### GET /videos/{public_id}/download (SI-03.11)

Igual ao stream, mas a URL força download via `ResponseContentDisposition: attachment; filename="{original_filename}"` (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — URL pré-assinada (TTL 900 s), host `S3_PUBLIC_ENDPOINT`
- expires_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente ou de outro canal
- 409 INVALID_VIDEO_STATE: vídeo não está em `ready` (per `phase-03-videos/TD-11`)
- 401: access token ausente ou inválido

#### Validation Rules — Upload

| Field | Rule | Error message |
|-------|------|---------------|
| filename | String não vazia, máx. 255 | filename must be shorter than or equal to 255 characters |
| mime_type | Um de `video/mp4`, `video/webm` | mime_type must be one of the following values: video/mp4, video/webm |
| size_bytes | Inteiro, mín. 1, máx. 10737418240 | size_bytes must not be greater than 10737418240 |
| title | Opcional; string 1..255 | title must be shorter than or equal to 255 characters |
| parts | Array com ≥ 1 item; `part_number` inteiro ≥ 1; `etag` string não vazia | parts must contain at least 1 elements |

### Authorization Matrix

Regra única da fase: somente o dono do canal acessa seus vídeos; rascunhos nunca são públicos (per `phase-03-videos/TD-11`). Vídeo de outro canal responde 404 `VIDEO_NOT_FOUND` (não revela existência). A checagem de posse vive no `VideosService` (regra de camadas do projeto), não em guard.

| Endpoint | Anonymous | Authenticated (não dono) | Owner | Status exigido |
|----------|-----------|--------------------------|-------|----------------|
| POST /videos | ✗ (401) | ✓ (cria no próprio canal) | ✓ | — |
| GET /videos/{public_id}/upload | ✗ (401) | ✗ (404) | ✓ | `draft` com `upload_id` |
| POST /videos/{public_id}/upload/complete | ✗ (401) | ✗ (404) | ✓ | `draft` |
| DELETE /videos/{public_id}/upload | ✗ (401) | ✗ (404) | ✓ | `draft` |
| GET /videos/{public_id} | ✗ (401) | ✗ (404) | ✓ | qualquer (per `phase-03-videos/TD-11` Revision) |
| GET /videos/{public_id}/stream | ✗ (401) | ✗ (404) | ✓ | `ready` |
| GET /videos/{public_id}/download | ✗ (401) | ✗ (404) | ✓ | `ready` |

### Error Catalog

**Error response format:** herdado da Fase 02 (per `phase-02-auth/TD-07`) — `{ statusCode: number, error: string, message: string }`, com `error` = código de domínio; erros de validação usam `error: "VALIDATION_ERROR"` e `message` como array. Novos códigos são `DomainException` em `src/common/exceptions/domain.exception.ts`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `public_id` inexistente ou pertencente a outro canal, em qualquer rota `/videos/{public_id}*` |
| INVALID_VIDEO_STATE | 409 | Operation not allowed for the current video status | Upload (retomar/concluir/cancelar) fora de `draft` ou retomada com `upload_id` nulo; stream/download fora de `ready` |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid or incomplete | `CompleteMultipartUpload` rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size does not match the declared size | `HeadObject` após conclusão retorna tamanho ≠ `declared_size_bytes`; objeto e rascunho são removidos |
| QUEUE_UNAVAILABLE | 503 | Video processing could not be scheduled, try again | `queue.add` falha ao publicar o job; status revertido para `draft` |

**Falhas de processamento** (não são respostas HTTP; gravadas em `videos.processing_error` com `status = 'failed'` pelo worker, per `phase-03-videos/TD-13`):

| Reason prefix | Kind | Trigger |
|---------------|------|---------|
| `NO_VIDEO_STREAM` | Permanente (`UnrecoverableError`) | ffprobe não encontra stream de vídeo |
| `PROBE_FAILED` | Permanente (`UnrecoverableError`) | ffprobe sai com código ≠ 0 por conteúdo inválido/corrompido |
| `PROCESSING_FAILED` | Transitória (esgotou `attempts`) | Erro de rede/storage/banco persistente após 3 tentativas |

### Events/Messages

#### video-processing → `process-video`

Fila BullMQ `video-processing` sobre Redis (per `phase-03-videos/TD-01`); único tipo de job da fase.

**Payload:**

```json
{ "videoId": "uuid" }
```

O payload carrega só o id interno; o worker lê o restante (`source_key`, `mime_type`, etc.) do banco (worker atualiza o banco diretamente, conforme o diagrama C4).

**Job options:** `jobId = videoId` (dedup por vídeo, per `phase-03-videos/TD-07`; UUID atende as restrições do BullMQ — sem `:` e não numérico, per `library-refs.md`), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (tentativas e tipo de backoff per `phase-03-videos/TD-13`; `delay` de 5 s é parâmetro do plano).
**Producer:** `VideoProcessingQueue` (`src/videos/`), chamado por `VideosService.completeUpload` após `draft → processing` (per `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessor` (`@Processor('video-processing')` + `WorkerHost`) registrado apenas no `WorkerModule`, executado no container `video-worker` (per `phase-03-videos/TD-02`)
**Trigger:** conclusão bem-sucedida do upload em `POST /videos/{public_id}/upload/complete`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`) — o processor é idempotente: só processa vídeos em `processing`, sobrescreve `thumbnail.jpg` e grava o resultado com update condicional `WHERE status = 'processing'`
**Outcomes:** sucesso → `status = 'ready'` + metadados + `thumbnail_key`; `UnrecoverableError` → `failed` imediato; erro transitório → retry com backoff; tentativas esgotadas → `failed` + `processing_error` (per `phase-03-videos/TD-13`)

---

## Dependency Map

```
SI-03.1 (root — infra, config, Compose)
├── SI-03.2 — StorageService (storage no Compose + config storage)
├── SI-03.3 — entidade Video + migration
├── SI-03.4 — fila video-processing (Redis + config queue)
└── SI-03.8 — MediaModule (FFmpeg na imagem; também depende de SI-03.2)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 — POST /videos (pré-cadastro + início do multipart)
    └── SI-03.6 — retomada e cancelamento (findOwnedByPublicId)
        ├── SI-03.7 — conclusão do upload + enqueue (também depende de SI-03.4)
        │   └── SI-03.9 — worker/VideoProcessor (também depende de SI-03.4 e SI-03.8)
        │       ├── SI-03.10 — GET /videos/{public_id} (caso com thumbnail)
        │       └── SI-03.11 — stream e download (vídeos ready)
        └── SI-03.10 — GET /videos/{public_id} (findOwnedByPublicId)

SI-03.5 + SI-03.6 + SI-03.7 + SI-03.9 + SI-03.10 + SI-03.11
└── SI-03.12 — fluxo E2E completo + OpenAPI + CLAUDE.md + diagrama
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (paralelos) → SI-03.8 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.9 → SI-03.10, SI-03.11 (paralelos) → SI-03.12

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose
- [ ] SI-03.2 — StorageModule: cliente S3, multipart e URLs pré-assinadas
- [ ] SI-03.3 — Entidade Video, migration e gerador de public_id
- [ ] SI-03.4 — Fila video-processing: conexão BullMQ e producer
- [ ] SI-03.5 — Endpoint POST /videos: pré-cadastro do rascunho e início do upload
- [ ] SI-03.6 — Endpoints de retomada e cancelamento do upload
- [ ] SI-03.7 — Endpoint POST /videos/{public_id}/upload/complete: conclusão do upload e disparo do processamento
- [ ] SI-03.8 — MediaModule: wrapper de ffprobe e ffmpeg
- [ ] SI-03.9 — Worker de vídeo: VideoProcessor, entrypoint standalone e container video-worker
- [ ] SI-03.10 — Endpoint GET /videos/{public_id}: leitura do vídeo pelo dono
- [ ] SI-03.11 — Endpoints de streaming e download
- [ ] SI-03.12 — Fluxo completo de ponta a ponta e documentação da fase

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`) — gera `dist/main.js` e `dist/worker.js`
