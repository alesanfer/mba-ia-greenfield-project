---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload-session.e2e-spec.ts
---

# GET / DELETE /videos/{public_id}/upload Test Plan

## Application Overview

Gerencia a sessão de upload multipart de um rascunho. `GET /videos/{public_id}/upload` retoma um upload interrompido: lista as partes que o storage já recebeu (`ListParts`) e reassina só as que faltam. `DELETE /videos/{public_id}/upload` cancela o upload: aborta o multipart, remove o objeto se ele existir e apaga o rascunho. Os dois exigem que o vídeo seja do usuário autenticado (para o não dono, o vídeo "não existe": 404) e que esteja em `draft`.

## Test Scenarios

### 1. Retomada do upload

**Setup:** `beforeAll`: `AppModule` com a config global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), bucket `streamtube-videos-test` e prefixo de fila `bull-test`. `beforeEach`: `cleanAllTables(dataSource)`, limpar o bucket de testes e o storage do throttler. Dois usuários confirmados e logados (dono e outro), via helper `registerConfirmAndLogin`. Rascunho criado com `POST /videos` pelo dono, com `size_bytes = 2 × 104857600 + 1024` (3 partes). `afterAll`: `app.close()`.

#### 1.1. retomada-lista-partes-enviadas-e-reassina-faltantes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. PUT de 104857600 bytes em `upload.parts[0].url`, direto no storage
    - expect: o storage responde `200` com `ETag`
  2. GET /videos/{public_id}/upload com o token do dono
    - expect: status `200`
    - expect: `part_size = 104857600` e `part_count = 3`
    - expect: `uploaded_parts` tem exatamente um item com `part_number: 1`, `etag` igual ao ETag do passo 1 e `size: 104857600`
    - expect: `parts` tem exatamente as partes 2 e 3, cada uma com `url` no host de `S3_PUBLIC_ENDPOINT`
    - expect: `expires_at` ≈ agora + 1h

#### 1.2. retomada-de-video-de-outro-canal-retorna-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. GET /videos/{public_id}/upload com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/ZZZZZZZZZZZ/upload (public_id inexistente) com o token do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`, com o mesmo corpo do passo 1

#### 1.3. retomada-de-video-em-processing-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. Atualizar o rascunho no banco para `status = 'processing'` e `upload_id = null`, simulando um upload já concluído
  2. GET /videos/{public_id}/upload com o token do dono
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`

#### 1.4. retomada-exige-autenticacao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. GET /videos/{public_id}/upload sem `Authorization`
    - expect: status `401`

### 2. Cancelamento do upload

**Setup:** igual ao grupo 1.

#### 2.1. cancelamento-remove-draft-e-aborta-multipart

**Covers AC:** #4, #5
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. Guardar `upload.parts[1].url`, emitida no `POST /videos`
  2. DELETE /videos/{public_id}/upload com o token do dono
    - expect: status `204` sem corpo
    - expect: não existe mais registro em `videos` com esse `id`
  3. GET /videos/{public_id} com o token do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  4. PUT de 1024 bytes na URL guardada no passo 1
    - expect: o storage rejeita com status ≥ 400 (`NoSuchUpload`): o multipart foi abortado
    - expect: `headObject(videos/{id}/source)` no bucket de testes retorna `null`

#### 2.2. cancelamento-de-video-ready-retorna-409

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. Atualizar o rascunho no banco para `status = 'ready'` e `upload_id = null`
  2. DELETE /videos/{public_id}/upload com o token do dono
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
    - expect: o registro continua em `videos` com `status = 'ready'`

#### 2.3. cancelamento-de-video-de-outro-canal-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. DELETE /videos/{public_id}/upload com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o rascunho do dono continua existindo em `videos`
