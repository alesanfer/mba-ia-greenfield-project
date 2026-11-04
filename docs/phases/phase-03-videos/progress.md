# phase-03-videos — Progress

**Status:** completed
**SIs:** 12/12 completed

### SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose
- **Status:** completed
- **Tests:** 22 passing (`src/config/env.validation.integration-spec.ts`, `src/config/storage.config.spec.ts`)
- **Observations:**
  - Ambiente estava parado e sem `node_modules`/`.env`: `.env` criado a partir do `.env.example`; container `cupom-fiscal-postgres` (outro projeto) parado para liberar a porta 5432, com autorização do usuário.
  - `.env.example` tem `MAIL_FROM="StreamTube" <noreply@streamtube.com>` sem aspas externas — o Docker Compose falha ao interpolar o `.env` copiado dele. Corrigido só no `.env` local; corrigir o `.env.example` é tarefa separada.
  - Baseline pré-fase: `src/database/migrations.integration-spec.ts` falha sempre que o banco já está migrado (remove tabelas mas não os tipos enum) e, ao falhar, deixa o schema sem as tabelas de token, quebrando o E2E em seguida. Será corrigido no SI-03.3, que edita esse arquivo.
  - `storage-init` usa a `minio-client` sem shell: provisiona os dois buckets com um único `mc mb --ignore-existing` via `MC_HOST_storage`. O healthcheck do `storage` usa `mc ready local` (a imagem Chainguard do MinIO inclui `mc`). Digests: minio `sha256:3c60a2a8…`, minio-client `sha256:1dccd2a6…`.
  - `storageConfig`/`queueConfig` também foram registrados no `load` do `ConfigModule` do `AppModule`, para os SIs 03.2 e 03.4 injetarem por `KEY`.
  - Helper `validate` do `env.validation.integration-spec.ts` tipado (+ `validValue`), eliminando os 2 erros de lint `no-unsafe-*` que já existiam no arquivo.
  - Lint pré-existente fora do escopo: `src/test/create-test-data-source.ts:9` (`no-unsafe-function-type`) — tratar antes da verificação final.
  - `createTestDataSource` lê `DB_DATABASE`, enquanto a aplicação usa `DB_NAME` (funciona por coincidência do default) — tarefa separada.

### SI-03.2 — StorageModule: cliente S3, multipart e URLs pré-assinadas
- **Status:** completed
- **Tests:** 12 passing (`src/storage/storage.module.spec.ts`, `src/storage/storage.service.integration-spec.ts`)
- **Observations:**
  - Os dois `S3Client` são providers do módulo (tokens `STORAGE_CLIENTS.INTERNAL`/`PUBLIC` em `storage.constants.ts`) e o `StorageService` faz `destroy()` deles no `onModuleDestroy`.
  - O SDK não tem classe modelada para `InvalidPart`/`InvalidPartOrder`: a tradução para `StorageInvalidPartsError` compara `S3ServiceException.name` com `INVALID_PARTS_ERROR_CODES`. O MinIO devolve `NoSuchUpload` ao concluir um upload abortado, então esse caso também vira `StorageInvalidPartsError`.
  - `listParts` pagina por `NextPartNumberMarker`, embora com partes de 100 MiB um vídeo tenha no máximo 103.
  - `downloadFilename` troca `"` e `\` por `_` antes de montar o `Content-Disposition`. Nomes não-ASCII (`filename*=UTF-8''…`) ficam para o SI-03.11 decidir, se forem necessários.
  - O helper `createStorageTestContext` se recusa a rodar se o bucket não for `streamtube-videos-test`. `clearBucket()` aborta multiparts pendentes e apaga todos os objetos.
  - Não testado: `onModuleDestroy`, que só destrói os clientes.

### SI-03.3 — Entidade Video, migration e gerador de public_id
- **Status:** completed
- **Tests:** 13 passing (`src/videos/entities/video.entity.integration-spec.ts`, `src/videos/public-id.util.spec.ts`, `src/database/migrations.integration-spec.ts`); as 14 suítes de `auth`/`channels`/`users` afetadas também passam (111 testes)
- **Observations:**
  - Migration gerada pela CLI: `1793789166550-CreateVideos.ts`. `migration:run` → `revert` → `run` validados no banco de dev: o revert remove só `videos` e `video_status`.
  - Baseline corrigido: `migrations.integration-spec.ts` agora remove também os tipos enum (`DROP TYPE IF EXISTS`) e faz os `DROP TABLE` em sequência, em vez de `Promise.all`, para evitar deadlock. Ele passa mesmo depois de outra suíte ter rodado `synchronize` no banco compartilhado.
  - `bigint` (`declared_size_bytes`, `size_bytes`) e `numeric` (`duration_seconds`) são tipados como `string` na entidade, porque o `pg` os devolve como string. Os SIs 03.5, 03.7 e 03.9 convertem na fronteira.
  - `generatePublicId` usa rejection sampling (descarta bytes ≥ 248) para não enviesar o alfabeto.
  - `create-test-data-source.ts` não tem lista central de entidades: `Video` foi acrescentado ao `cleanAllTables` e ao array `ALL_ENTITIES` das 10 specs que carregam `Channel` (sem ele, o metadata de `Channel#videos` não resolve). Tarefa separada: centralizar essa lista no helper.
  - **Correção feita durante o SI-03.4, aprovada pelo usuário:** o lado inverso `Channel#videos` impedia o `AppModule` de subir (`Entity metadata for Channel#videos was not found`), porque nenhum módulo registrava `Video` em `forFeature` antes do SI-03.5. Isso quebrava todas as E2E. Foi criado um `src/videos/videos.module.ts` mínimo, só com `TypeOrmModule.forFeature([Video])`, registrado no `AppModule`. O SI-03.5 só estende esse módulo.
  - Lint preexistente fora do escopo (mesmos 75 erros do `HEAD`, nenhum introduzido): `auth.service.spec.ts` (45), `channels.service.spec.ts` (15), `auth.service.integration-spec.ts` (7), `channels.service.ts` (6), `users.service.integration-spec.ts` (1), `create-test-data-source.ts` (1). Eles bloqueiam o `npm run lint` da verificação final e precisam ser tratados antes dela.

### SI-03.4 — Fila video-processing: conexão BullMQ e producer
- **Status:** completed
- **Tests:** 7 passing (`src/videos/processing/video-processing.module.spec.ts`, `src/videos/processing/video-processing.queue.integration-spec.ts`); E2E existentes também passam (3 suítes, 52 testes) com `QueueModule` e `VideosModule` no `AppModule`
- **Observations:**
  - **Desvio de versão aprovado pelo usuário:** `@nestjs/bullmq` instalado em `^11.0.5`, e não `^12.0.0`. A 12.0.0 e a `@nestjs/bull-shared@12` são ESM puro e quebram o Jest CommonJS no import. A 11.0.5 é CommonJS, tem a mesma API e aceita `bullmq ^6` e Nest 11. Registrado como revisão em `phase-03-videos/TD-01` e no `library-refs.md`, o que muda o mtime dessas fontes para o `plan-validate`.
  - Com o Redis inalcançável, o BullMQ espera para sempre o `ready` da conexão (`RedisConnection.waitUntilReady` com `retryStrategy` infinito). Por isso o `enqueue` limita o `queue.add` com `ENQUEUE_TIMEOUT_MS = 5000` e rejeita com `ProcessingQueueUnavailableError` (`video-processing.errors.ts`), que o SI-03.7 mapeia para `QUEUE_UNAVAILABLE`. O teste confirma a rejeição em ~5 s.
  - Efeito colateral do timeout: o `queue.add` abandonado pode ser concluído se o Redis voltar, deixando um job "zumbi" para um vídeo que o SI-03.7 já reverteu para `draft`. O processor do SI-03.9 já ignora vídeos fora de `processing`. Mas, como o `jobId = videoId`, um novo `enqueue` desse vídeo é descartado enquanto o job zumbi existir. Ponto a considerar no SI-03.7/03.9 (`removeOnComplete`/`removeOnFail`).
  - O `QueueModule` foi registrado no `AppModule`; o `VideoProcessingModule` será importado pelo `VideosModule` no SI-03.5. O teste de compilação verifica, via `DiscoveryService`, que nenhum provider tem metadata de `@Processor`.
  - O Jest reporta um open handle `CustomGC` nas E2E com `--detectOpenHandles`. Não investiguei se ele já existia antes; provavelmente vem de módulo nativo (argon2), não da fila.

### SI-03.8 — MediaModule: wrapper de ffprobe e ffmpeg
- **Status:** completed
- **Tests:** 24 passing (`src/media/media-probe.service.spec.ts`, `src/media/media-probe.service.integration-spec.ts`, `src/media/thumbnail.service.integration-spec.ts`)
- **Observations:**
  - A classificação vem de mensagens reais do ffprobe 5.1 (stderr), capturadas no container. Rede, DNS e HTTP 4xx/5xx (ex.: URL pré-assinada expirada → 403) viram `MediaTransientError`. Timeout (processo morto) e falha de execução (`error.code` string: `ENOENT`, maxBuffer) também são transitórios, para que um problema de infraestrutura não marque o vídeo como `failed` permanente. Qualquer outra saída ≠ 0 do ffprobe vira `ProbeFailedError`. Coberto por testes unitários de `MediaExecError.transient`.
  - Toda falha do `extractThumbnail` é `MediaTransientError`: ele roda depois de um `probe` bem-sucedido, então o conteúdo já foi validado. Saída vazia também conta como transitória.
  - `NoVideoStreamError` desconsidera streams `attached_pic` (capa em arquivos de áudio).
  - Os erros expõem `permanent: boolean` (base `MediaError`) e as mensagens começam com os prefixos do Error Catalog (`NO_VIDEO_STREAM`, `PROBE_FAILED`), para o SI-03.9 gravar em `processing_error`. O transitório usa o prefixo `MEDIA_TRANSIENT`; o SI-03.9 grava `PROCESSING_FAILED` ao esgotar as tentativas.
  - `ProbeResult.sizeBytes` é `number` (10 GiB < 2^53). A coluna `size_bytes` é string (bigint), e o SI-03.9 converte.
  - Binários chamados via `execFile` com args em array (sem shell) e `killSignal: SIGKILL` no timeout. Os timeouts são 60 s (probe) e 120 s (thumbnail), em `media.constants.ts`. O frame sai por `pipe:1`, sem arquivo local.
  - As fixtures são geradas uma vez por container em `os.tmpdir()/streamtube-media-fixtures` e servidas por URL pré-assinada interna do bucket de testes.
  - O `MediaModule` não tem imports configurados, então não há teste de compilação (o plano também não pede).

### SI-03.5 — Endpoint POST /videos: pré-cadastro do rascunho e início do upload
- **Status:** completed
- **Tests:** 25 passing (`src/videos/videos.service.spec.ts` 16, `src/videos/videos.service.integration-spec.ts` 3, `src/videos/videos.module.spec.ts` 1, `src/channels/channels.service.integration-spec.ts` 5); E2E `test/videos-create.e2e-spec.ts` 6 passing (cenários 1.1–2.3 do `specs/videos-create.plan.md`). Todas as E2E (4 suítes, 58 testes) e `openapi-export.integration-spec.ts` (9) continuam passando.
- **Observations:**
  - Resposta documentada com DTOs de resposta (`CreateVideoResponseDto`, `UploadSessionDto`, `UploadPartUrlDto` com `@ApiProperty`), em vez de schema inline. Assim o SI-03.6 reusa `UploadSessionDto` no `GET …/upload`. O `buildUploadSession` (privado no `VideosService`) também foi feito para esse reuso.
  - Usuário autenticado sem canal é invariante quebrada (todo usuário ganha canal no registro): lança `Error` comum → 500, sem código de domínio novo, porque o Error Catalog não prevê esse caso.
  - Retry de `public_id`: só repete em violação de unicidade cujo `detail` cita `public_id`, até `PUBLIC_ID_MAX_ATTEMPTS = 5`. Qualquer falha do insert (ou esgotar as tentativas) dispara `abortMultipartUpload`, e o erro original é relançado. Se o próprio abort falhar, ele é logado e não mascara o erro original. O multipart pendurado fica para a limpeza de abandonados, que é tarefa futura (TD-06 Revision).
  - `videos.constants.ts` já traz todos os TTLs da fase e os helpers `videoSourceKey`/`videoThumbnailKey`, para os SIs seguintes não duplicarem literais.
  - As 5 exceções do Error Catalog foram adicionadas a `domain.exception.ts`. Por enquanto só existem; quem lança são os SIs 03.6, 03.7, 03.10 e 03.11.
  - `VideosModule` já importa `VideoProcessingModule` (per plano), embora o producer só seja injetado no SI-03.7.
  - E2E: o helper `registerConfirmAndLogin` foi reescrito localmente com `app.get(MailService)` em vez de `(authService as any).mailService`, para não acrescentar erros de lint. Ele continua duplicado em relação a `auth.e2e-spec.ts`. Tarefa separada: extrair para `src/test/`.

### SI-03.6 — Endpoints de retomada e cancelamento do upload
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` + `src/videos/videos.service.integration-spec.ts` + `src/storage` → 53 passing; E2E `test/videos-upload-session.e2e-spec.ts` 7 passing (cenários 1.1–2.3 do `specs/videos-upload-session.plan.md`). Demais E2E (auth/app/swagger/videos-create) e `openapi-export.integration-spec.ts` continuam passando.
- **Observations:**
  - **Pendência para o SI-03.10:** o passo 3 do cenário 2.1 (`GET /videos/{public_id}` → 404 `VIDEO_NOT_FOUND`) depende de uma rota que ainda não existe. Hoje o teste verifica só o `404`, que vem do roteador, e cobre o `VIDEO_NOT_FOUND` pelo `GET …/upload`. Ao implementar o SI-03.10, apertar essa asserção para `error: "VIDEO_NOT_FOUND"` em `test/videos-upload-session.e2e-spec.ts`.
  - **Ajuste no `StorageService` (SI-03.2):** o `abortMultipartUpload` passou a ser idempotente (`NoSuchUpload` → sucesso), para o `DELETE …/upload` poder ser repetido se uma tentativa anterior abortou o multipart mas falhou ao apagar o registro. Coberto por um teste novo em `storage.service.integration-spec.ts`.
  - `findOwnedByPublicId` resolve o canal via `ChannelsService.findByUserId` e filtra o vídeo por `public_id` + `channel_id`. Usuário sem canal também responde `VIDEO_NOT_FOUND`.
  - `cancelUpload` segue a ordem abort → `headObject`/`deleteObject` → delete do registro. Se o storage falhar, o rascunho é mantido para nova tentativa.
  - `buildUploadSession` agora recebe `partCount` e um conjunto de partes a pular. `UploadStatusResponseDto` estende `UploadSessionDto` com `uploaded_parts`.

### SI-03.7 — Endpoint POST /videos/{public_id}/upload/complete: conclusão do upload e disparo do processamento
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` + `videos.service.integration-spec.ts` + `videos.module.spec.ts` → 54 passing (integração com Redis real, inclusive o cenário de Redis inalcançável + retry); E2E `test/videos-upload-complete.e2e-spec.ts` 7 passing (cenários 1.1–2.6 do `specs/videos-upload-complete.plan.md`). Todas as E2E (6 suítes, 72 testes) e `openapi-export.integration-spec.ts` passam.
- **Observations:**
  - **Desvio de nome:** o item do request é `CompleteUploadPartDto`, e não `UploadedPartDto` como diz o plano. Esse nome já é do DTO de resposta da retomada (SI-03.6), e duas classes homônimas colidem nos schemas do OpenAPI.
  - Sequência implementada:
    1. `findOwnedByPublicId` + `draft`.
    2. `completeMultipart`, só se houver `upload_id`. As partes são ordenadas por `part_number`, porque o S3 exige ordem crescente e o cliente pode mandar fora de ordem. Em seguida, `upload_id = null`.
    3. `headObject` contra `declared_size_bytes`. Objeto ausente também conta como divergência: o rascunho é irrecuperável sem multipart e sem objeto.
    4. `update` condicional `WHERE status = 'draft'` para `processing` + `size_bytes`. Se `affected = 0`, responde `INVALID_VIDEO_STATE`, sem enfileirar.
    5. `enqueue`. Só `ProcessingQueueUnavailableError` reverte para `draft` (`WHERE status = 'processing'`) e vira `QUEUE_UNAVAILABLE`; outros erros propagam.
  - Interação com o job "zumbi" do SI-03.4: se um `add` abandonado pelo timeout chegar depois ao Redis, o retry do cliente encontra o job (dedup por `jobId`) e responde 202. O worker vai encontrar o vídeo em `processing`, ou seja, o zumbi passa a ser útil. O risco que sobra fica para o SI-03.9: o worker consome o zumbi enquanto o vídeo ainda está em `draft` (ignora) e o job fica retido em `completed`, bloqueando o reenfileiramento. Definir `removeOnComplete`/`removeOnFail` lá.
  - Teste de integração "Redis inalcançável": módulo separado com `REDIS_PORT=6390` e `console.error` silenciado só nesse bloco, porque o BullMQ loga o `ECONNREFUSED` esperado antes de o listener de `error` ser registrado.

### SI-03.9 — Worker de vídeo: VideoProcessor, entrypoint standalone e container video-worker
- **Status:** completed
- **Tests:** `src/videos/processing/video.processor.spec.ts` (15), `src/videos/processing/video.processor.integration-spec.ts` (5, Worker BullMQ real in-process via `WorkerModule.init()`, cobrindo ready, `NO_VIDEO_STREAM` na 1ª tentativa, `PROCESSING_FAILED` após 3 tentativas, recuperação após falha transitória e job repetido sobre vídeo `ready`), `src/worker.module.spec.ts` (2). Suíte completa: 39 suítes, 292 testes; E2E: 6 suítes, 72 testes; `npm run build` gera `dist/main.js` e `dist/worker.js`.
- **Observations:**
  - **Container verificado:** `docker compose up -d video-worker` sobe o serviço `running`, com o log `Video worker started` e conexão BullMQ em `bull:video-processing`, separado do `nestjs-api`. Não verifiquei manualmente o fluxo "worker parado → jobs ficam na fila → processados ao subir"; isso é garantia do BullMQ e ficou sem teste dedicado.
  - **Ajuste nas opções do job (SI-03.4):** `PROCESS_VIDEO_JOB_OPTIONS` ganhou `removeOnComplete: true` e `removeOnFail: true`. Com `jobId = videoId`, um job retido em `completed`/`failed` faria o BullMQ ignorar qualquer novo enqueue do vídeo, que era o risco do job "zumbi" anotado nos SIs 03.4 e 03.7. O resultado fica no banco (`status`/`processing_error`).
  - **Semântica de tentativas, conferida no código do `bullmq@6.5.4`:** o evento `failed` dispara a cada tentativa, depois do `moveToFailed` incrementar o `attemptsMade`. Na última, `attemptsMade === opts.attempts`. O handler grava `failed` só quando o erro é irrecuperável (por `instanceof` ou por `name === 'UnrecoverableError'`) ou na última tentativa. Ele loga e não relança.
  - **Outdir próprio do worker (desvio do plano):** `start:worker` é `nest start --watch --entryFile worker --path tsconfig.worker.json`, com `outDir: dist-worker`. Como o projeto usa `deleteOutDir: true` e os dois containers compartilham o volume, o watcher do worker apagaria o `dist/` do `start:dev` da API, e vice-versa. Por isso `dist-worker` entrou no `.gitignore` e no `exclude` do `tsconfig.json` e do `tsconfig.build.json`. O `start:worker:prod` continua `node dist/worker`, gerado pelo `npm run build` normal.
  - **`WorkerModule` registra `Channel` e `User` em `forFeature`:** sem eles o metadata de `Video#channel` não resolve, porque o `autoLoadEntities` só enxerga entidades em `forFeature`, o mesmo problema do SI-03.3. O TypeORM ficava em retry, o `init` falhava e deixava um Worker BullMQ pendurado, o que travou a primeira execução dos testes por mais de 10 min.
  - **`WorkerModule` duplica o `ConfigModule` e o `TypeOrmModule.forRootAsync` do `AppModule`** (mesmos namespaces e schema Joi), como o plano pede. Tarefa separada: extrair a config raiz compartilhada para os dois entrypoints não divergirem.
  - **Coluna `metadata` (jsonb):** no `update` foi preciso fazer cast para `QueryDeepPartialEntity<Video>['metadata']`, porque a tipagem deep-partial do TypeORM não aceita `Record<string, unknown>`.
  - O `VideoProcessor` descarta o resultado (log `warn`) se o vídeo saiu de `processing` durante o job, por causa do update condicional.
  - A suíte do SI-03.4 (`video-processing.queue.integration-spec.ts`) demora ~2 s para o Jest sair ("did not exit one second after"), pela reconexão do cenário de Redis inalcançável. Não trava.

### SI-03.10 — Endpoint GET /videos/{public_id}: leitura do vídeo pelo dono
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` (+4 em `getOwnedVideo`: assinatura do thumbnail no endpoint público com o TTL de 3600 s e conversão de `bigint`/`numeric` para `number`; `thumbnail_url` nulo sem assinar; campos internos ausentes; 404 propagado), `src/videos/videos.service.integration-spec.ts` (+1: a `thumbnail_url` serve o JPEG direto do MinIO com `200` e `image/jpeg`), `test/videos-get.e2e-spec.ts` (5 cenários do spec). Suíte completa: 39 suítes, 297 testes; E2E: 7 suítes, 77 testes; `tsc` e lint dos arquivos alterados sem erros.
- **Observations:**
  - O cenário 1.2 do E2E leva o vídeo a `ready` pelo fluxo HTTP real (`POST /videos`, `PUT` da fixture `MP4_360P` como parte única, `upload/complete`) e roda `VideoProcessor.process` in-process, obtido de um `WorkerModule` só compilado (sem `init`, então nenhum Worker BullMQ sobe), como o TD-16 prevê.
  - No teste de integração, o thumbnail é um JPEG real de 64×64 gerado com ffmpeg e gravado no storage, sem rodar o worker. O caminho do worker já é coberto pelo E2E.
  - `test/videos-upload-session.e2e-spec.ts`, cenário 2.1: o passo 3 agora usa `GET /videos/{public_id}` e verifica `error: "VIDEO_NOT_FOUND"`. O substituto temporário pela rota de upload foi removido, como o plano pedia.
  - A resposta também omite `thumbnail_key`, que o contrato não lista. O teste unitário cobre isso junto com os outros campos internos.

### SI-03.11 — Endpoints de streaming e download
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` (+6: endpoint público e TTL de 3600 s no stream; TTL de 900 s e `downloadFilename = original_filename` no download; `INVALID_VIDEO_STATE` sem assinar nada em `draft`/`processing`/`failed`; 404 propagado), `src/videos/videos.service.integration-spec.ts` (+2 com MinIO real: `Range` na URL de stream responde `206` com o `Content-Range` e os bytes certos; a URL de download responde `Content-Disposition: attachment; filename="minha-aula.mp4"` com o arquivo inteiro), `test/videos-stream-download.e2e-spec.ts` (7 testes cobrindo os 5 cenários do spec, com o 2.1 parametrizado por status). Suíte completa: 39 suítes, 305 testes; E2E: 8 suítes, 84 testes; `tsc` sem erros; lint dos arquivos alterados sem erros novos.
- **Observations:**
  - **Fixture nova `MP4_OVER_1MIB`** em `src/test/media-fixtures.helper.ts`: H.264 lossless de 4 s em 640×360, ~1,9 MB. O spec pede uma fixture maior que 1 MiB para a leitura com `Range` de 1 MiB, e nenhuma das existentes chegava a isso (a maior tinha 240 KB). O E2E confere o tamanho no `beforeAll`.
  - No E2E, o vídeo chega a `ready` pelo fluxo HTTP real mais `VideoProcessor.process` in-process (TD-16), como no SI-03.10. No teste de integração, o objeto de 2 MiB é gravado direto no storage (o multipart aberto é abortado antes) e o vídeo é marcado `ready` no banco.
  - `expires_at` é calculado antes da assinatura, então nunca passa da expiração real da URL.

### SI-03.12 — Fluxo completo de ponta a ponta e documentação da fase
- **Status:** completed
- **Tests:** `test/videos-flow.e2e-spec.ts` (1). Só por HTTP e `PUT`s nas URLs pré-assinadas: registro, confirmação, login, `POST /videos`, upload das partes da fixture `MP4_OVER_1MIB`, `upload/complete`, consumo do job **lido da fila** (o mesmo publicado pela API) por um `VideoProcessor` in-process, `GET /videos/{public_id}` em `ready` com metadados e thumbnail acessível, `Range` de 1 MiB no stream → `206` com os bytes certos, download → arquivo idêntico com `Content-Disposition`. Suíte completa: 39 suítes, 305 testes; E2E: 9 suítes, 85 testes; `tsc` sem erros; `npm run build` gera `dist/main.js` e `dist/worker.js`.
- **Observations:**
  - **Desvio aprovado: script `openapi:export` corrigido.** O script rodava com `ts-node`, sem o plugin do `@nestjs/swagger`, e todos os DTOs de request saíam com `properties: {}`, inclusive os da fase 02 (`RegisterDto` etc., já assim no arquivo commitado). Com o OK do usuário, o script virou `nest build && node dist/openapi-export.js`. O `openapi.json` foi regerado com os 7 endpoints `/videos` e os schemas de request completos.
  - `nestjs-project/CLAUDE.md`: serviços `video-worker`, `mailpit`, `redis`, `storage` e `storage-init`; checagens de prontidão (`redis-cli ping`, healthcheck do storage, `storage-init` com exit 0, log do worker); scripts `start:worker`, `start:worker:prod` e `openapi:export`; isolamento de bucket e fila nos testes; seção "Two entrypoints" com as regras "API nunca recebe bytes de vídeo" e "worker nunca é importado pelo `AppModule`"; módulos de vídeo.
  - `CLAUDE.md` da raiz: containers atualizados (fila = Redis + BullMQ) e uma seção "Videos (Phase 03)" com módulos, os 7 endpoints e o fluxo. `docs/diagrams/software-arch.mermaid`: fila `TBD` → `Redis (BullMQ)`, worker como `Nest.js + FFmpeg`, e as relações com o storage passam a citar URLs pré-assinadas.
  - **Lint (decisão do usuário: corrigir na fase):** o `eslint` sem `--fix` apontava 148 erros, todos em código de fases anteriores e nenhum em código desta fase. A contagem de 75 registrada antes deixava arquivos de fora. Foram corrigidos sem mudar comportamento:
    - `channels.service.ts`: leitura tipada de `code`/`detail` do `QueryFailedError`, no lugar de `as any`. Único arquivo de produção alterado.
    - `src/test/mailpit.ts`: tipos para as respostas da API do Mailpit.
    - `create-test-data-source.ts`: `entities` tipado como `DataSourceOptions['entities']`.
    - `auth.service.spec.ts`: mocks como `Record<keyof T, jest.Mock>` (elimina o `unbound-method`) e fixtures tipadas com as entidades.
    - `channels.service.spec.ts`: mocks tipados.
    - Specs dos filtros: sem `as any` no `ArgumentsHost`, e `expect.any(String) as string`.
    - `auth.service.integration-spec.ts` e `test/auth.e2e-spec.ts`: spies no `MailService` sem `as any`, e `res.body` lido via `bodyOf()`.
    - Variáveis e imports sem uso removidos.
    - Resultado: `npm run lint` passa com 0 erros (1 warning de `no-unsafe-argument`, configurado como `warn`).

## Final verification

- Backend tests: `npm test -- --runInBand` → 39 suítes, 305 testes, todos passando.
- E2E: `npm run test:e2e` → 9 suítes, 85 testes, todos passando.
- `npx tsc --noEmit` → exit 0.
- `npm run lint` → 0 erros.
- `npm run build` → gera `dist/main.js` e `dist/worker.js`.
- Deliverables: SI-03.1 a SI-03.12 concluídos (ver acima).
