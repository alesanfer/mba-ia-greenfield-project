---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/{public_id}/upload/complete Test Plan

## Application Overview

Conclui o upload multipart de um rascunho. A rota chama `CompleteMultipartUpload`, confere o tamanho real do objeto (`HeadObject`) contra o `declared_size_bytes` e faz a transição `draft → processing`, publicando o job `process-video` (`jobId = id`) na fila `video-processing`. Se a publicação falhar, a operação é idempotente: o status volta para `draft` com `upload_id = null`, a API responde 503, e uma nova chamada pula o `CompleteMultipartUpload` e só reconfere o tamanho e reenfileira o job.

## Test Scenarios

### 1. Conclusão bem-sucedida

**Setup:** `beforeAll`: `AppModule` com a config global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), bucket `streamtube-videos-test`, `S3_PUBLIC_ENDPOINT=http://storage:9000` e prefixo de fila `bull-test` vindos de `src/test/setup-test-env.ts` (carregado em `setupFiles` antes do `dotenv/config`, per SI-03.1). `beforeEach`: `cleanAllTables(dataSource)`, limpar o bucket de testes, `obliterate` da fila de testes e limpar o storage do throttler. Dono (e outro usuário) confirmados e logados via `registerConfirmAndLogin`. Rascunho criado com `POST /videos` e `size_bytes = 1048576` (1 parte), e a parte enviada por PUT direto na URL pré-assinada, guardando o `ETag`. `afterAll`: `app.close()`.

#### 1.1. conclui-upload-e-muda-para-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. POST /videos/{public_id}/upload/complete com o token do dono e body `{ "parts": [{ "part_number": 1, "etag": "<ETag>" }] }`
    - expect: status `202` com `{ id, public_id, status: "processing" }`
    - expect: no banco, o vídeo tem `status = 'processing'`, `upload_id = null` e `size_bytes = 1048576` (tamanho real do objeto)
  2. Ler o job da fila de testes `video-processing` por `jobId = id`
    - expect: o job existe, com `name = "process-video"` e `data = { "videoId": "<id do vídeo>" }`
    - expect: `opts.attempts = 3` e `opts.backoff = { type: 'exponential', delay: 5000 }`

### 2. Falhas de conclusão

**Setup:** igual ao grupo 1.

#### 2.1. etag-invalido-retorna-400-e-mantem-draft

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. POST /videos/{public_id}/upload/complete com `{ "parts": [{ "part_number": 1, "etag": "\"00000000000000000000000000000000\"" }] }`
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
    - expect: no banco, o vídeo continua `status = 'draft'` e com `upload_id` não nulo
    - expect: nenhum job na fila de testes para esse `id`

#### 2.2. tamanho-divergente-retorna-422-e-remove-objeto-e-registro

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. Criar outro rascunho com `size_bytes = 1048576` e enviar uma única parte com 524288 bytes, guardando o `ETag`
  2. POST /videos/{public_id}/upload/complete com essa parte
    - expect: status `422` com `error: "UPLOAD_SIZE_MISMATCH"`
    - expect: não existe mais registro em `videos` para esse `id`
    - expect: `headObject(videos/{id}/source)` no bucket de testes retorna `null`

#### 2.3. fila-indisponivel-retorna-503-e-retry-conclui

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. Simular a indisponibilidade do Redis com `jest.spyOn(app.get(VideoProcessingQueue), 'enqueue').mockRejectedValueOnce(new Error('Connection is closed'))`; o comportamento com o Redis realmente parado é coberto pelo teste de integração de SI-03.7
  2. POST /videos/{public_id}/upload/complete com a parte válida
    - expect: status `503` com `error: "QUEUE_UNAVAILABLE"`
    - expect: no banco, o vídeo tem `status = 'draft'` e `upload_id = null` (o multipart já foi concluído)
  3. Repetir o mesmo POST, agora sem o mock
    - expect: status `202` com `status: "processing"`
    - expect: o job `process-video` com `jobId = id` está na fila de testes

#### 2.4. video-em-processing-retorna-409

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. Concluir o upload com sucesso (`202`)
  2. Repetir POST /videos/{public_id}/upload/complete com a mesma parte
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
    - expect: a fila de testes continua com um único job para esse `id`

#### 2.5. parts-vazio-retorna-400-validation-error

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. POST /videos/{public_id}/upload/complete com `{ "parts": [] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` mencionando `parts`
    - expect: o vídeo continua `draft`

#### 2.6. nao-dono-e-anonimo-sao-rejeitados

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. POST /videos/{public_id}/upload/complete com o token do outro usuário e a parte válida
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. Mesmo POST sem `Authorization`
    - expect: status `401`
    - expect: o vídeo continua `draft` em ambos os casos
