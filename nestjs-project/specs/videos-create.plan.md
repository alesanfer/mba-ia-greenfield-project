---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como `draft` no canal do usuário autenticado, abre um S3 Multipart Upload e devolve uma URL pré-assinada de `UploadPart` por parte (100 MiB cada), no host de `S3_PUBLIC_ENDPOINT`. Assim o cliente envia o arquivo direto ao storage, sem que nenhum byte do vídeo passe pela API. O `title` é opcional e, quando ausente, vem do nome do arquivo sem a extensão.

## Test Scenarios

### 1. Pré-cadastro do rascunho

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo o `main.ts` (`ValidationPipe` com whitelist/forbidNonWhitelisted/transform, `DomainExceptionFilter` e `ValidationExceptionFilter`), com o bucket `streamtube-videos-test` (`src/test/storage-test.helper.ts`) e o prefixo de fila `bull-test` (`src/test/queue-test.helper.ts`). `beforeEach`: `cleanAllTables(dataSource)`, limpar os objetos do bucket de testes e o storage do throttler. Usuário confirmado com canal criado e logado via helper `registerConfirmAndLogin` (mesmo padrão de `test/auth.e2e-spec.ts`). `afterAll`: `app.close()`.

#### 1.1. cria-draft-com-titulo-default-e-urls-de-parte

**Covers AC:** #1, #3
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "filename": "aula.mp4", "mime_type": "video/mp4", "size_bytes": 262144000 }`
    - expect: status `201`
    - expect: body tem `id` (uuid), `public_id` com 11 caracteres de `[0-9A-Za-z]`, `title: "aula"`, `status: "draft"`
    - expect: `upload.part_size = 104857600`, `upload.part_count = 3`, `upload.parts` com 3 itens de `part_number` 1, 2 e 3, cada um com `url` não vazia
    - expect: `upload.expires_at` é uma ISO-8601 ≈ agora + 1h
  2. Consultar `videos` pelo `id` retornado
    - expect: existe um registro com `status = 'draft'`, `channel_id` igual ao canal do usuário autenticado, `declared_size_bytes = 262144000`, `upload_id` não nulo, `source_key = videos/{id}/source`, `original_filename = 'aula.mp4'` e `mime_type = 'video/mp4'`

#### 1.2. cria-draft-com-titulo-informado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "aula.webm", "mime_type": "video/webm", "size_bytes": 1048576, "title": "Introdução ao NestJS" }`
    - expect: status `201`
    - expect: `title: "Introdução ao NestJS"` e `upload.part_count = 1`

#### 1.3. urls-de-parte-no-host-publico-e-aceitam-put

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "clip.mp4", "mime_type": "video/mp4", "size_bytes": 1024 }`
    - expect: status `201`
    - expect: o `origin` de toda `upload.parts[].url` é igual ao de `S3_PUBLIC_ENDPOINT` da configuração de teste, e nenhuma URL aponta para o host da API
  2. PUT de 1024 bytes direto em `upload.parts[0].url`, usando o cliente HTTP do teste e não a API
    - expect: o storage responde `200` com header `ETag`
    - expect: a API nunca recebeu esses bytes; a requisição não passou por `app.getHttpServer()`

### 2. Rejeições

**Setup:** igual ao grupo 1.

#### 2.1. rejeita-mime-fora-da-allowlist

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "aula.mkv", "mime_type": "video/x-matroska", "size_bytes": 1024 }`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` (array) mencionando `mime_type`
    - expect: nenhum registro criado em `videos`

#### 2.2. rejeita-tamanho-acima-de-10-gib

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "big.mp4", "mime_type": "video/mp4", "size_bytes": 10737418241 }`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` mencionando `size_bytes`
    - expect: nenhum registro criado em `videos`

#### 2.3. exige-autenticacao

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-04T01:02:00Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhum registro criado em `videos`
