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

<!-- SIs will be written in Phase B -->

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

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
