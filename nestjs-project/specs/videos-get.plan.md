---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: nestjs-project/test/videos-get.e2e-spec.ts
---

# GET /videos/{public_id} Test Plan

## Application Overview

Devolve ao dono o estado de um vídeo do próprio canal, em qualquer status (`draft`, `processing`, `ready`, `failed`): título, status, metadados extraídos e `thumbnail_url`, que é uma URL pré-assinada e vem nula enquanto o vídeo não tem thumbnail. Isso permite acompanhar o processamento. Campos internos (`upload_id`, `source_key`, `declared_size_bytes`, `channel_id`, `metadata`) nunca aparecem na resposta, e para quem não é dono o vídeo "não existe" (404). A listagem fica para a Fase 04.

## Test Scenarios

### 1. Leitura pelo dono

**Setup:** `beforeAll`: `AppModule` com a config global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), bucket `streamtube-videos-test` e fila com prefixo `bull-test`. `beforeEach`: `cleanAllTables(dataSource)`, limpar o bucket de testes, a fila de testes e o storage do throttler. Dono e outro usuário confirmados e logados via `registerConfirmAndLogin`. Para chegar a um vídeo `ready`, criar o rascunho com `POST /videos`, enviar como parte única uma fixture MP4 gerada por `src/test/media-fixtures.helper.ts`, concluir com `POST .../upload/complete` e executar `VideoProcessor.process` in-process, obtido de um `WorkerModule` de teste (per TD-16), com um job `{ data: { videoId } }`. `afterAll`: `app.close()`.

#### 1.1. draft-retorna-200-com-metadados-nulos

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. Criar um rascunho com `POST /videos` (`{ "filename": "aula.mp4", "mime_type": "video/mp4", "size_bytes": 1024 }`)
  2. GET /videos/{public_id} com o token do dono
    - expect: status `200` com `public_id`, `title: "aula"`, `status: "draft"`, `original_filename: "aula.mp4"` e `mime_type: "video/mp4"`
    - expect: `thumbnail_url: null`, `size_bytes: null`, `duration_seconds: null`, `width: null`, `height: null`, `video_codec: null`, `audio_codec: null` e `processing_error: null`
    - expect: `created_at` e `updated_at` em ISO-8601
    - expect: o corpo não tem as chaves `upload_id`, `source_key`, `channel_id`, `metadata` nem `declared_size_bytes`

#### 1.2. ready-retorna-metadados-e-thumbnail-acessivel

**Covers AC:** #2, #5
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. Levar um vídeo até `ready` pelo fluxo do Setup
  2. GET /videos/{public_id} com o token do dono
    - expect: status `200` com `status: "ready"`
    - expect: `duration_seconds` > 0, `width` e `height` iguais aos da fixture, `video_codec: "h264"` e `size_bytes` igual ao tamanho da fixture
    - expect: `thumbnail_url` não nula, no host de `S3_PUBLIC_ENDPOINT`
    - expect: o corpo não tem `upload_id`, `source_key`, `channel_id` nem `metadata`
  3. GET em `thumbnail_url` direto no storage
    - expect: status `200` com `Content-Type: image/jpeg` e corpo começando com `FF D8`

#### 1.3. failed-retorna-processing-error

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. Criar um rascunho e atualizá-lo no banco para `status = 'failed'`, `upload_id = null` e `processing_error = 'NO_VIDEO_STREAM: no video stream found'`
  2. GET /videos/{public_id} com o token do dono
    - expect: status `200` com `status: "failed"` e `processing_error` começando com `NO_VIDEO_STREAM`
    - expect: `thumbnail_url: null`

### 2. Acesso negado

**Setup:** igual ao grupo 1, com um rascunho criado pelo dono.

#### 2.1. outro-canal-retorna-404-igual-a-inexistente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. GET /videos/{public_id} com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/ZZZZZZZZZZZ com o token do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"` e o mesmo `message` do passo 1, sem revelar se o vídeo existe

#### 2.2. exige-autenticacao

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. GET /videos/{public_id} sem `Authorization`
    - expect: status `401`
