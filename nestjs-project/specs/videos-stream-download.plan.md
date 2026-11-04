---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos-stream-download.e2e-spec.ts
---

# GET /videos/{public_id}/stream e /download Test Plan

## Application Overview

Entrega ao dono URLs pré-assinadas do arquivo original de um vídeo `ready`, sempre no host de `S3_PUBLIC_ENDPOINT`; os bytes nunca passam pela API. `/stream` devolve uma URL de `GetObject` com TTL de 1h, e o storage atende `Range` com `206 Partial Content` (reprodução progressiva sem baixar o arquivo inteiro). `/download` devolve uma URL com TTL de 15 min que força o download com `Content-Disposition: attachment; filename="<original_filename>"`. Vídeos fora de `ready` respondem 409, e os de outro canal respondem 404.

## Test Scenarios

### 1. Vídeo ready do dono

**Setup:** `beforeAll`: `AppModule` com a config global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`), bucket `streamtube-videos-test`, `S3_PUBLIC_ENDPOINT=http://storage:9000` e prefixo de fila `bull-test` vindos de `src/test/setup-test-env.ts` (carregado em `setupFiles` antes do `dotenv/config`, per SI-03.1). `beforeEach`: `cleanAllTables(dataSource)`, limpar o bucket de testes, a fila de testes e o storage do throttler. Dono e outro usuário confirmados e logados via `registerConfirmAndLogin`. Vídeo `ready` com `original_filename = "minha-aula.mp4"`: rascunho via `POST /videos`, fixture MP4 de `src/test/media-fixtures.helper.ts` (maior que 1 MiB) enviada como parte única, `POST .../upload/complete` e `VideoProcessor.process` executado in-process (per TD-16). `afterAll`: `app.close()`.

#### 1.1. stream-retorna-url-com-ttl-de-1h-e-suporta-range

**Covers AC:** #1, #2, #6
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. GET /videos/{public_id}/stream com o token do dono
    - expect: status `200` com `{ url, expires_at }`
    - expect: `expires_at` ≈ agora + 3600 s (tolerância de alguns segundos)
    - expect: o `origin` de `url` é igual ao de `S3_PUBLIC_ENDPOINT`, e não ao host da API
  2. GET em `url` direto no storage com header `Range: bytes=0-1048575`
    - expect: status `206 Partial Content`
    - expect: header `Content-Range` começando com `bytes 0-1048575/` e terminando no tamanho total da fixture
    - expect: corpo com exatamente 1048576 bytes

#### 1.2. download-retorna-url-com-ttl-de-15min-e-content-disposition

**Covers AC:** #3, #6
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. GET /videos/{public_id}/download com o token do dono
    - expect: status `200` com `{ url, expires_at }`
    - expect: `expires_at` ≈ agora + 900 s
    - expect: o `origin` de `url` é igual ao de `S3_PUBLIC_ENDPOINT`
  2. GET em `url` direto no storage, sem `Range`
    - expect: status `200`
    - expect: header `Content-Disposition: attachment; filename="minha-aula.mp4"`
    - expect: tamanho do corpo igual ao da fixture (arquivo completo)

### 2. Estados inválidos e acesso negado

**Setup:** igual ao grupo 1; os estados não `ready` são obtidos criando um rascunho e ajustando o `status` no banco.

#### 2.1. stream-e-download-fora-de-ready-retornam-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. Para cada status em `draft`, `processing` e `failed`, deixar o vídeo do dono nesse status
  2. GET /videos/{public_id}/stream com o token do dono
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`
  3. GET /videos/{public_id}/download com o token do dono
    - expect: status `409` com `error: "INVALID_VIDEO_STATE"`

#### 2.2. outro-canal-retorna-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. GET /videos/{public_id}/stream do vídeo `ready` do dono, com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/{public_id}/download com o token do outro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 2.3. exige-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T01:11:09Z

**Steps:**
  1. GET /videos/{public_id}/stream e GET /videos/{public_id}/download sem `Authorization`
    - expect: status `401` em ambas
