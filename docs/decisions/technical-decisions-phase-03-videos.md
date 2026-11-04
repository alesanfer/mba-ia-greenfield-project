---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-03
scope_description: "Fase 03 — Upload e Processamento de Vídeos: tecnologia de fila, worker de vídeo (FFmpeg), object storage S3-compatível e seu uso (buckets/chaves, URLs pré-assinadas), protocolo de upload de até 10GB, gatilho de processamento, URL única, streaming/download, ciclo de status e política de falhas, e estratégia de testes com infraestrutura real."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o módulo de vídeos (pré-cadastro, orquestração do upload, URL única, entrega de stream/download), a tabela `videos`, o cliente de object storage, a produção de jobs na fila, o worker de vídeo (FFmpeg) e a infraestrutura nova no `compose.yaml` (storage, fila, worker). Coberto por TD-01..TD-16.
- `next-frontend/` — sem implementação nesta fase (o enunciado e o `project-plan.md` não listam telas de vídeo na Fase 03). As TDs `Cross-layer` (TD-06, TD-07, TD-09, TD-10, TD-11) fixam **apenas o contrato** que o frontend consumirá nas Fases 04/05; nenhuma decisão exclusivamente de frontend é aberta aqui.

> **Nota de verificação de documentação:** o servidor MCP `context7` não está configurado nesta sessão (`.mcp.json` só declara `postgres`). Seguindo a cadeia de verificação, as versões foram conferidas diretamente no registry npm e no Docker Hub em 2026-11-03, e as APIs/limites em documentação oficial (links em _Sources_). `/plan-resolve` deve reconfirmar via `context7` ao gerar o `library-refs.md`.

---

## TD-01: Tecnologia de fila (message queue)

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama C4 (`docs/diagrams/software-arch.mermaid`) deixa a fila como `TBD`; é a principal decisão de stack da fase. A fila desacopla a API (que publica o job ao fim do upload) do worker (que consome e roda FFmpeg). Requisitos: retentativas com backoff, deduplicação de job por vídeo, rodar em container no Compose e integração madura com NestJS 11.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Fila baseada em Redis; pacote oficial `@nestjs/bullmq@12.0.0` (peer `@nestjs/common ^10||^11||^12`, `bullmq ^3..^6`; `bullmq@6.5.4` atual). Producer via `@InjectQueue`, consumer via `@Processor` + `WorkerHost`.
- **Pros:** integração oficial documentada em docs.nestjs.com; `attempts` + `backoff` (fixed/exponential/custom) nativos; `jobId` customizável dá deduplicação por vídeo; `UnrecoverableError` encerra retentativas para erros permanentes; Redis sobe com uma linha no Compose.
- **Cons:** novo serviço de infraestrutura (Redis) para operar; semântica "at-least-once" exige processor idempotente; persistência de jobs depende da configuração de AOF/RDB do Redis.

### Option B: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- Broker AMQP dedicado; publish em exchange, consumo por fila com ack manual. `@golevelup/nestjs-rabbitmq@9.1.1` exige `@nestjs/common ^11.1.24`.
- **Pros:** broker de mensageria "de verdade" (routing, DLX nativa, garantias de entrega fortes); agnóstico de linguagem — worker poderia ser outra stack.
- **Cons:** retry com backoff exige montar DLX + TTL manualmente; integração NestJS é de terceiros (ou `@nestjs/microservices`, que não modela jobs); mais conceitos (exchange, binding, prefetch) para um único tipo de job.

### Option C: pg-boss (fila sobre o PostgreSQL existente)
- Jobs persistidos em tabelas do próprio Postgres (`pg-boss@12.38.0`), com `SKIP LOCKED` para consumo concorrente.
- **Pros:** zero infraestrutura nova; job e update do vídeo podem compartilhar a mesma transação (elimina o problema de dual-write).
- **Cons:** sem integração oficial NestJS; carga de polling no banco transacional; o diagrama prevê um container de fila separado e o enunciado reprova "não ter fila real subindo no Compose" — pg-boss tornaria a fila indistinguível do banco.

**Recommendation:** **Option A (BullMQ + Redis)** — é o único caminho com integração oficial NestJS 11 cobrindo retry/backoff/dedup nativamente, e o Redis materializa o container `Message Queue` do diagrama sem a carga operacional de topologia AMQP que um único tipo de job não justifica.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq
**Revisions:**
- 2026-11-04 — Versão do `@nestjs/bullmq` fixada em `^11.0.5` em vez de `^12.0.0`. A 12.0.0 (e a `@nestjs/bull-shared@12`) é publicada como ESM puro (`"type": "module"`); o Jest do projeto (CommonJS + ts-jest) falha ao importá-la (`SyntaxError: Unexpected token 'export'`). A 11.0.5 é CommonJS, tem a mesma API e aceita `bullmq ^6` e `@nestjs/* ^10||^11`. A 12 só adiciona suporte ao NestJS 12. Rationale: desvio aprovado pelo usuário durante o implement do SI-03.4; reavaliar ao migrar o projeto para NestJS 12.

---

## TD-02: Modelo de execução do worker de vídeo

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O diagrama define o `Video Worker` como container próprio que lê/grava no storage e atualiza o banco. É preciso decidir onde o código do worker vive e como ele é iniciado, o que afeta `compose.yaml`, Dockerfile, reuso de entidades/config e testes. Depende de TD-01.

**Options:**

### Option A: Mesmo codebase NestJS, entrypoint separado, container próprio
- `nestjs-project/src/worker.ts` cria um `NestFactory.createApplicationContext(WorkerModule)` (sem HTTP) que registra o `@Processor`. Serviço `video-worker` no Compose usa a mesma imagem (+ FFmpeg) com outro comando.
- **Pros:** reusa entidade `Video`, `ConfigModule`/Joi, TypeORM e cliente S3 sem duplicação; um único `package.json`/lint/tsc; atende o container separado do diagrama.
- **Cons:** a imagem do worker carrega dependências da API que não usa; acoplamento de deploy (mesma versão de código para API e worker).

### Option B: Subprojeto separado (`video-worker/`) no monorepo
- Novo projeto Node independente consumindo a fila, com seu próprio manifest, config e acesso ao banco.
- **Pros:** isolamento total de dependências e deploy; poderia ser outra linguagem.
- **Cons:** duplica entidade/esquema, validação de env e cliente S3; dobra a superfície de tooling (lint, tsc, testes) — contraria "continuidade, não retrabalho".

### Option C: Processor no próprio processo da API
- `@Processor` registrado no `AppModule` da API (ou sandboxed via `processors: [path]`, que roda em fork sem DI).
- **Pros:** mais simples; nenhum container novo.
- **Cons:** FFmpeg disputa CPU/memória com as requisições HTTP ("sem impacto na performance" fica comprometido); não materializa o container `Video Worker` do diagrama.

**Recommendation:** **Option A** — container separado protege a API da carga do FFmpeg (exigência da fase) enquanto o codebase compartilhado preserva entidades, migrations e config já existentes como fonte única.

**Decision:** A (Mesmo codebase, entrypoint e container próprios)

---

## TD-03: Imagem do object storage S3-compatível no ambiente local

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O enunciado assume "S3 em produção, MinIO local". Porém, verificado em 2026-11-03: o repositório `minio/minio` foi **arquivado (25/04/2026) e a edição community passou a ser distribuída somente como código-fonte**; `minio/minio` e `quay.io/minio/minio` não resolvem mais nos registries. A escolha de *qual* storage (S3) não é reaberta — o que precisa ser decidido é a imagem local que emula a API S3 no Compose.

**Options:**

### Option A: MinIO via imagem Chainguard (`cgr.dev/chainguard/minio`), fixada por digest
- Build mantido pela Chainguard do código MinIO, gratuito; acompanhado de `cgr.dev/chainguard/minio-client` para provisionar bucket. O tier gratuito expõe essencialmente `latest`, então a fixação é por digest `@sha256:...`.
- **Pros:** mantém o MinIO previsto pelo enunciado e pela comunidade; API S3 madura (multipart, presigned, Range); imagens com CVEs corrigidos pela Chainguard.
- **Cons:** upstream sem manutenção — correções dependem de terceiro; atualizar exige trocar digest manualmente.

### Option B: RustFS (`rustfs/rustfs:1.0.4`)
- Object storage em Rust, Apache-2.0, posicionado como substituto do MinIO; tags semânticas publicadas no Docker Hub.
- **Pros:** projeto ativo com versão fixável por tag; API S3 com multipart e presigned documentados.
- **Cons:** maturidade ainda contestada (sinais divergentes sobre prontidão para produção; relatos de presigned PUT sem enforcement de Content-Type); risco de divergência sutil da semântica S3.

### Option C: SeaweedFS com gateway S3 (`chrislusf/seaweedfs`, `server -s3`)
- Sistema de arquivos distribuído maduro com endpoint S3; modo `server` single-container para dev.
- **Pros:** muito maduro e ativo; desempenho bom com arquivos grandes.
- **Cons:** arquitetura mais complexa (master/volume/filer) e configuração S3 (identities via JSON) menos direta; a fidelidade ao S3 não é o foco principal do projeto.

**Recommendation:** **Option A** — preserva a premissa do enunciado (MinIO) com uma imagem mantida e reprodutível por digest; como o código só fala o protocolo S3 (TD-04), trocar para B/C depois é uma mudança restrita ao `compose.yaml`.

**Decision:** A (MinIO Chainguard fixado por digest)

---

## TD-04: Cliente S3 e endpoints para URLs pré-assinadas

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** API e worker precisam operar o storage (multipart, HeadObject, PutObject do thumbnail) e assinar URLs que o **navegador** vai usar. Dentro do Compose o storage responde em `http://<serviço>:9000` (regra de Docker Networking do `CLAUDE.md`), host que não é resolvível pelo navegador. A escolha é contrato entre schema Joi, `compose.yaml`, `.env.example` e código (critério (a)).

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) com dois endpoints
- Um `S3Client` para operações servidor→storage (`S3_ENDPOINT`, host do serviço Compose) e outro, sem I/O, usado só para assinar URLs com `S3_PUBLIC_ENDPOINT` (host acessível pelo cliente). `forcePathStyle: true` para MinIO. Versão atual `3.1161.0`.
- **Pros:** é o SDK de produção (S3 real) — troca de ambiente é só env; presigner suporta `UploadPartCommand`/`GetObjectCommand` com `ResponseContentDisposition`; assinatura é offline, então o segundo cliente não precisa alcançar o host público.
- **Cons:** SDK modular verboso; duas instâncias de client para configurar.

### Option B: SDK `minio` (minio-js)
- Cliente oficial do MinIO com `presignedPutObject`/`presignedGetObject`.
- **Pros:** API mais enxuta.
- **Cons:** acopla o código ao fornecedor cuja edição community foi descontinuada (TD-03); presign de partes multipart não é API de primeira classe; migração para S3 real fica menos garantida.

**Recommendation:** **Option A** — o SDK v3 é o mesmo de produção e a separação `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` resolve o problema de host interno vs. navegador sem violar a regra de rede Docker.

**Decision:** A (AWS SDK v3 com dois endpoints)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-05: Organização de buckets e chaves no storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** API e worker precisam derivar as mesmas chaves de objeto; a tabela `videos` guarda essas chaves (requisito do enunciado). A política de acesso por bucket também define se thumbnails podem ser servidos sem assinatura no futuro (grids das Fases 04/07).

**Options:**

### Option A: Bucket único privado, prefixo por vídeo
- Um bucket (`S3_BUCKET`) com chaves `videos/{videoId}/source` e `videos/{videoId}/thumbnail.jpg` (`videoId` = UUID interno). Todo acesso externo via URL pré-assinada.
- **Pros:** um bucket para provisionar e configurar; tudo de um vídeo sob um prefixo (limpeza por prefixo); chave independe do slug público (TD-09).
- **Cons:** thumbnails exigem assinatura em listagens futuras (custo baixo, mas uma URL por item).

### Option B: Dois buckets — `videos` privado e `thumbnails` público para leitura
- Arquivos originais privados (presigned); thumbnails servidos por URL pública estável.
- **Pros:** URLs de thumbnail cacheáveis e estáveis; simplifica listagens das fases seguintes.
- **Cons:** dois buckets e duas políticas para provisionar/testar; exposição pública de thumbnails de rascunhos (Fase 03 só tem rascunhos — conflita com TD-11).

**Recommendation:** **Option A** — com todos os vídeos em rascunho nesta fase, nada deve ser público; um bucket privado com prefixo por `videoId` é o mínimo suficiente, e a Fase 04 pode introduzir um bucket público se a visibilidade justificar.

**Decision:** A (Bucket único privado, prefixo por vídeo)

---

## TD-06: Protocolo de upload de até 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O enunciado reprova passar o arquivo pela API de forma que a trave, e o `project-plan.md` (Pontos de Atenção) exige poder **retomar** após falha de conexão. Um `PUT` único pré-assinado está descartado: o limite do S3 para operação única é 5 GB. O protocolo define o handshake que o frontend implementará (contrato BE↔FE).

**Options:**

### Option A: S3 Multipart Upload com URLs pré-assinadas por parte (upload direto ao storage)
- API inicia (`CreateMultipartUpload`), devolve URLs pré-assinadas de `UploadPart`; o cliente envia as partes direto ao storage e informa os `ETag`s; a API conclui (`CompleteMultipartUpload`). Retomada: API lista partes já recebidas (`ListParts`) e reassina as faltantes. Limites S3: partes de 5 MiB–5 GiB, máx. 10.000 partes.
- **Pros:** zero bytes de vídeo passam pela API; partes paralelas e retomáveis; nativo do S3 (funciona igual em produção).
- **Cons:** handshake de 3+ chamadas no cliente; URLs expiram (precisa endpoint de reassinatura); ETags precisam ser expostos via CORS do storage.

### Option B: tus (resumable upload protocol) via API (`@tus/server` + `@tus/s3-store`)
- A API expõe um endpoint tus; o cliente (ex.: `tus-js-client`) envia chunks à API, que os repassa ao S3 em multipart.
- **Pros:** protocolo de retomada padronizado com clientes prontos.
- **Cons:** todos os 10GB atravessam a API (banda/CPU/conexões presas no processo HTTP); duas libs novas; contraria o fluxo `Frontend → Storage` do diagrama.

### Option C: `multipart/form-data` em streaming pela API (busboy → `Upload` do SDK)
- A API recebe o stream e repassa ao storage sem bufferizar em disco.
- **Pros:** cliente trivial (um `POST`).
- **Cons:** sem retomada (falha de conexão reinicia os 10GB); conexão HTTP longa ocupando a API — o padrão que o enunciado reprova.

**Recommendation:** **Option A** — é a única opção que tira a API do caminho dos dados e entrega retomada nativa; sugestão de parâmetros para `/plan-build`: parte fixa de 100 MiB (≤ 103 partes para 10 GiB) e URLs de parte com expiração de 1h, reassináveis.

**Decision:** A (S3 Multipart Upload com URLs pré-assinadas por parte)
**Revisions:**
- 2026-11-03 — Fase 03 inclui endpoint de cancelamento do upload: executa `AbortMultipartUpload` no storage e remove o registro do vídeo em `draft`; limpeza automática de rascunhos abandonados (cliente nunca chama `complete`) fica como tarefa futura documentada. Rationale: resolve AMB-4 (validation phase-03-videos) — casos de borda de upload cancelado/abandonado.

---

## TD-07: Gatilho do processamento após o upload

**Scope:** Cross-layer

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Alguém precisa detectar que o upload terminou, mudar o status e publicar o job. A escolha define quem fala com a fila e se o frontend faz a chamada de conclusão. Depende de TD-01 e TD-06.

**Options:**

### Option A: Conclusão explícita via API (`complete` chamado pelo cliente)
- O cliente chama o endpoint de conclusão com os ETags; a API executa `CompleteMultipartUpload`, valida tamanho via `HeadObject`, muda status para `processing` e publica o job (`jobId` = `videoId` para deduplicar).
- **Pros:** fluxo síncrono e determinístico, fácil de testar em e2e; a API é a única produtora da fila (como no diagrama `API → Queue`); portável entre MinIO e S3.
- **Cons:** se o cliente nunca chamar `complete`, o vídeo fica em rascunho (precisa política de abandono); dual-write banco + fila exige ordem/compensação definida.

### Option B: Notificação de evento do storage (bucket notification)
- O storage emite evento `s3:ObjectCreated:CompleteMultipartUpload` (webhook/Redis/AMQP) e um consumidor publica o job.
- **Pros:** o processamento começa mesmo que o cliente caia após a última parte.
- **Cons:** configuração de notificação difere entre MinIO/RustFS e S3 (EventBridge/SQS) — perde portabilidade; ainda é preciso o `complete` do multipart; fluxo assíncrono mais difícil de testar.

**Recommendation:** **Option A** — mantém a API como única produtora da fila conforme o diagrama e torna o fluxo testável de ponta a ponta; a ordem sugerida (atualizar status → enfileirar com `jobId` idempotente → reverter em falha de enqueue) cabe ao `/plan-build`.

**Decision:** A (Conclusão explícita via API)

---

## TD-08: Limites e formatos de vídeo aceitos

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A Fase 03 só exige extração de metadados e thumbnail — **não** transcodificação. Sem transcodificação, apenas containers/codecs reproduzíveis pelo navegador funcionarão no streaming (TD-10). Também é preciso fixar a unidade do limite "10GB" e onde ele é verificado. O limite aparece no DTO, na validação pós-upload e na mensagem de erro (critério (a)).

**Options:**

### Option A: Allowlist de formatos reproduzíveis no navegador, sem transcodificação
- Aceita `video/mp4` e `video/webm` declarados no início do upload; tamanho declarado ≤ 10 GiB (10 × 1024³ bytes) validado no início e reconferido via `HeadObject` na conclusão; o worker confirma via ffprobe que há stream de vídeo (senão `failed`).
- **Pros:** tudo que fica `ready` toca no navegador; validação em três pontos sem custo extra.
- **Cons:** rejeita `.mov`/`.mkv`/`.avi` que usuários podem ter.

### Option B: Aceita qualquer `video/*`, sem transcodificação
- Mesmos limites de tamanho; nenhum filtro de container.
- **Pros:** menos atrito no upload.
- **Cons:** vídeos chegam a `ready` mas não tocam no player (falha silenciosa para o usuário).

### Option C: Aceita qualquer `video/*` e transcodifica para H.264/AAC MP4 no worker
- O worker gera uma rendition MP4 normalizada além do thumbnail.
- **Pros:** qualquer entrada vira um vídeo reproduzível.
- **Cons:** fora das capacidades da fase; processamento de 10GB levaria horas de CPU; dobra o armazenamento.

**Recommendation:** **Option A** — cumpre as capacidades sem extrapolar para transcodificação e garante que "pronto" signifique "reproduzível"; ampliar a allowlist ou adicionar transcodificação fica para fase futura.

**Decision:** A (Allowlist mp4/webm, sem transcodificação)

---

## TD-09: Estratégia de URL única por vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** O `project-plan.md` pede "URL curta e única que nunca conflite". O identificador aparece nas rotas da API e nas futuras rotas do frontend (`/watch/{id}`), e é coluna da tabela `videos` — contrato BE↔FE.

**Options:**

### Option A: UUID da chave primária na URL
- Reusa o `id` UUID (padrão do projeto via `@PrimaryGeneratedColumn('uuid')`).
- **Pros:** nenhuma coluna ou geração nova; unicidade garantida.
- **Cons:** 36 caracteres — não é "curta"; expõe o id interno.

### Option B: ID público aleatório curto (base62, 11 caracteres) com índice único
- Coluna `public_id` gerada no pré-cadastro com `crypto.randomBytes` (sem dependência nova) em alfabeto base62; índice `UNIQUE` + retry em colisão (62¹¹ ≈ 5,2 × 10¹⁹ combinações).
- **Pros:** curta e não enumerável (estilo YouTube); desacopla URL pública do id interno; a garantia final de unicidade é o índice do banco.
- **Cons:** coluna e lógica de geração/retry extras.

### Option C: Sqids/Hashids sobre sequência numérica
- Codifica um `bigint` sequencial em string curta reversível.
- **Pros:** curta e sem colisão por construção.
- **Cons:** exige coluna sequencial além do UUID; reversível — enumerável se o alfabeto vazar; dependência nova.

**Recommendation:** **Option B** — entrega URL curta e não enumerável sem dependência nova (o `nanoid@6` atual é ESM-only, atrito desnecessário com o build CommonJS do projeto), apoiando a unicidade no índice do PostgreSQL.

**Decision:** B (ID público base62 de 11 caracteres com índice único)

---

## TD-10: Entrega de streaming e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** O diagrama define `Frontend → Object Storage: Streams`. Streaming progressivo exige suporte a `Range`/`206 Partial Content`. O contrato da resposta da API (redirect vs. JSON) é consumido pelo frontend via BFF — e o BFF (`phase-02-auth-frontend/TD-01`) injeta o `Authorization` upstream, algo que um `<video src>` direto no navegador não faria. Depende de TD-04 e TD-11.

**Options:**

### Option A: URL pré-assinada de GET retornada em JSON
- `GET` de stream devolve `{ url, expires_at }` com URL `GetObject` assinada; download usa a mesma mecânica com `ResponseContentDisposition: attachment; filename="..."`. Range/206 é servido pelo storage.
- **Pros:** zero bytes de vídeo pela API; Range/seek nativos do S3; JSON atravessa o BFF com autenticação e o navegador usa a URL diretamente.
- **Cons:** URL expira (player precisa renovar em sessões longas); URL vazada é válida até expirar.

### Option B: Proxy na API com repasse de `Range`
- A API lê o `Range` do request, faz `GetObject` com o mesmo range e repassa o stream com `206`.
- **Pros:** controle total de acesso por requisição; URL estável.
- **Cons:** todo o tráfego de vídeo passa pela API (mesmo problema que TD-06 evita); conexões longas no processo HTTP.

### Option C: HLS (segmentos + playlist `.m3u8`) gerado no worker
- O worker segmenta o vídeo; o player consome a playlist.
- **Pros:** streaming adaptativo padrão de mercado.
- **Cons:** exige transcodificação/segmentação (excluída em TD-08); armazenamento e processamento multiplicados; fora das capacidades da fase.

**Recommendation:** **Option A** — segue o fluxo do diagrama, delega Range/206 ao storage e devolve JSON que passa pelo BFF autenticado; sugestão de expiração para `/plan-build`: 1h para stream e 15 min para download.

**Decision:** A (URL pré-assinada de GET retornada em JSON)

---

## TD-11: Política de acesso a stream/download nesta fase

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Na Fase 03 todo vídeo é rascunho; visibilidade público/unlisted chega na Fase 04 e acesso anônimo na Fase 05. A Authorization Matrix do plano precisa de uma regra agora, e a regra muda o comportamento do guard JWT global (rotas `@Public()` ou não).

**Options:**

### Option A: Somente o dono do canal, e somente com status `ready`
- Rotas autenticadas; serviço verifica que o vídeo pertence ao canal do usuário; status ≠ `ready` responde conflito.
- **Pros:** não expõe rascunhos; a Fase 04/05 apenas relaxa a regra (adiciona caminho público para vídeos publicados).
- **Cons:** o fluxo anônimo só será exercitado nas fases seguintes.

### Option B: Qualquer pessoa com o ID público, quando `ready` (comportamento "unlisted")
- Rotas `@Public()`; o ID não enumerável (TD-09) funciona como segredo.
- **Pros:** antecipa a Fase 05.
- **Cons:** publica rascunhos antes de existir fluxo de publicação (Fase 04); decisão de visibilidade tomada fora de sua fase.

**Recommendation:** **Option A** — mantém rascunhos privados até a Fase 04 definir visibilidade, sem nada a desfazer depois (só a adição de um caminho público).

**Decision:** A (Somente o dono do canal, somente com status ready)
**Revisions:**
- 2026-11-03 — Fase 03 expõe apenas leitura individual de um vídeo do próprio dono (status, duração, metadados, `public_id` e thumbnail via URL pré-assinada), com a mesma regra de dono desta TD (sem a restrição de `ready`, para acompanhar o processamento); listagem de vídeos fica para a Fase 04. Rationale: resolve AMB-5 (validation phase-03-videos) — fronteira com o painel da Fase 04.

---

## TD-12: Modelo de status do vídeo

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O enunciado exige o ciclo `rascunho → processando → pronto/erro` no banco. A Fase 04 traz "Fluxo de rascunho → publicação" — se a mesma coluna carregar as duas semânticas, "rascunho" fica ambíguo. O enum é escrito pela API e pelo worker (critério (a)).

**Options:**

### Option A: Enum único cobrindo processamento e publicação
- `status`: `draft → processing → ready → (Fase 04: published)` | `failed`.
- **Pros:** uma coluna só.
- **Cons:** mistura dois eixos; na Fase 04, um vídeo publicado que precise reprocessar não tem representação; transições ficam combinatórias.

### Option B: Enum de processamento; publicação em eixo ortogonal (Fase 04)
- `status`: `draft` (pré-cadastrado, upload em andamento) → `processing` → `ready` | `failed`. A Fase 04 adiciona visibilidade/publicação em colunas próprias.
- **Pros:** corresponde literalmente ao ciclo do enunciado; transições simples e lineares; Fase 04 não precisa migrar valores do enum.
- **Cons:** "rascunho" da Fase 04 (não publicado) será um conceito diferente do `draft` deste enum — exige documentar.

**Recommendation:** **Option B** — atende o ciclo pedido sem antecipar o modelo de publicação da Fase 04; transições permitidas: `draft→processing` (API, no `complete`), `processing→ready|failed` (worker).

**Decision:** B (Enum de processamento; publicação ortogonal)
**Revisions:**
- 2026-11-03 — No pré-cadastro (`draft`) o cliente informa nome do arquivo, MIME e tamanho; título é opcional e, quando ausente, deriva do nome do arquivo sem extensão (edição de título é da Fase 04). Rationale: resolve AMB-1 (validation phase-03-videos) — dados exigidos ao iniciar o upload.

---

## TD-13: Política de falha e retentativa no processamento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O enunciado pede definir "o que acontece em caso de falha no processamento". Falhas podem ser transitórias (storage/banco indisponível) ou permanentes (arquivo corrompido, sem stream de vídeo). Depende de TD-01 e TD-12.

**Options:**

### Option A: Retentativas automáticas com backoff exponencial; erros permanentes falham imediatamente
- Job com `attempts: 3`, `backoff: exponential`; erros de conteúdo lançam `UnrecoverableError` (sem retry). Após esgotar, worker grava `failed` + motivo (`processing_error`). Status `failed` é terminal nesta fase.
- **Pros:** absorve falhas transitórias sem intervenção; não desperdiça CPU reprocessando arquivo inválido; motivo visível no banco.
- **Cons:** processor precisa ser idempotente (thumbnail sobrescrito, update condicional).

### Option B: Sem retentativa — primeira falha é terminal
- **Pros:** mais simples.
- **Cons:** uma oscilação de rede marca vídeos válidos como `failed` sem recuperação.

### Option C: Option A + endpoint de reprocessamento manual
- **Pros:** dono recupera vídeos `failed` sem novo upload.
- **Cons:** endpoint e regras extras não previstos nas capacidades da fase.

**Recommendation:** **Option A** — usa as primitivas nativas do BullMQ (TD-01) para separar falha transitória de permanente, sem criar endpoints fora do escopo; reprocessamento manual pode virar tarefa futura.

**Decision:** A (Retentativas exponenciais + UnrecoverableError)

---

## TD-14: Integração com FFmpeg/ffprobe

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O worker precisa extrair duração/metadados (ffprobe) e um frame (ffmpeg). A forma de obter o binário afeta o Dockerfile do worker e o da API (testes rodam no container `nestjs-api`, ver TD-16).

**Options:**

### Option A: Binários do sistema (`apt install ffmpeg`) invocados via `child_process.execFile`/`spawn`
- `ffprobe -v error -print_format json -show_format -show_streams` e `ffmpeg -ss <t> -i <input> -frames:v 1` chamados por um serviço fino, com timeout.
- **Pros:** nenhuma dependência npm; versão do FFmpeg da distro (Debian da imagem `node:25.6.0-slim`); saída JSON do ffprobe é estável e tipável.
- **Cons:** wrapper próprio (parse de JSON, timeout, stderr); imagem cresce (~centenas de MB).

### Option B: `fluent-ffmpeg`
- API fluente sobre os binários.
- **Pros:** API conhecida.
- **Cons:** **pacote deprecado no npm** ("no longer supported"); sem manutenção — inadequado para código novo.

### Option C: Binários via npm (`ffmpeg-static`/`ffprobe-static`)
- Binários baixados no `npm install`.
- **Pros:** não depende do apt da imagem.
- **Cons:** download de binário no install; versões dos pacotes defasadas em relação ao FFmpeg; duas dependências para algo que a distro já provê.

**Recommendation:** **Option A** — o uso se limita a dois comandos bem definidos; um wrapper próprio de poucas linhas sobre o binário da distro evita dependência deprecada ou binários baixados no install.

**Decision:** A (Binários do sistema via child_process)
**Revisions:**
- 2026-11-03 — Metadados persistidos: colunas tipadas para duração, largura, altura, codec de vídeo, codec de áudio e tamanho real do arquivo, mais coluna `jsonb` com o restante da saída do ffprobe. Rationale: resolve AMB-2 (validation phase-03-videos) — conjunto e formato dos metadados.
- 2026-11-03 — Thumbnail: JPEG extraído do frame em 10% da duração (piso no segundo 0 para vídeos muito curtos), redimensionado para largura máxima de 1280px mantendo a proporção. Rationale: resolve AMB-3 (validation phase-03-videos) — frame, formato e dimensões do thumbnail.

---

## TD-15: Acesso do worker ao arquivo de origem

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O arquivo pode ter 10GB. ffprobe precisa só dos headers/átomos de índice e ffmpeg de um único frame. Baixar o arquivo inteiro custaria disco e tempo. Depende de TD-04 e TD-14.

**Options:**

### Option A: ffprobe/ffmpeg leem a URL pré-assinada diretamente via HTTP
- O worker gera uma URL `GetObject` de curta duração com o endpoint interno e a passa como `-i`; o protocolo HTTP do FFmpeg faz requisições `Range` sob demanda.
- **Pros:** lê só os bytes necessários (KB–MB, não GB); nenhum volume temporário; tempo de processamento independe do tamanho do arquivo.
- **Cons:** MP4 com `moov` no fim exige seeks extras (resolvidos por Range); erros de rede aparecem como falha do ffprobe (cobertos pelo retry de TD-13).

### Option B: Download para volume temporário e processamento local
- **Pros:** I/O local previsível; FFmpeg sem dependência de rede.
- **Cons:** até 10GB de disco por job concorrente; minutos de download antes de extrair alguns KB de metadados.

**Recommendation:** **Option A** — evita mover 10GB para extrair metadados e um frame; o custo (seeks HTTP) é absorvido pelo suporte nativo a Range do storage.

**Decision:** A (FFmpeg lê a URL pré-assinada via HTTP Range)

---

## TD-16: Estratégia de testes com fila, storage e worker reais

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O enunciado exige "não mocke o que dá para testar de verdade com a infra do Compose". Os testes rodam dentro do container `nestjs-api` (`nestjs-project/CLAUDE.md`), em banco compartilhado com `--runInBand`. É preciso definir como integração/e2e alcançam Redis/storage e como o processor é exercitado — afeta Dockerfile, `compose.yaml`, env e setup do Jest (critério (a)).

**Options:**

### Option A: Serviços do Compose + recursos de teste isolados + processor in-process
- Testes usam os containers reais de Redis e storage, com bucket e prefixo de fila próprios de teste; integração/e2e instanciam o processor do worker no próprio processo do Jest (FFmpeg instalado também na imagem de dev da API) e aguardam o status no banco. Fixture: vídeo curto gerado por `ffmpeg -f lavfi` no setup.
- **Pros:** segue o padrão já usado com o PostgreSQL compartilhado; determinístico (o teste controla quando o worker roda); nenhuma dependência nova.
- **Cons:** imagem de dev da API cresce com FFmpeg; teste não cobre o entrypoint do container do worker (precisa smoke manual/verificação de `docker compose ps`).

### Option B: Testcontainers
- Cada suíte sobe seus containers efêmeros.
- **Pros:** isolamento total.
- **Cons:** exige Docker-in-Docker dentro do container `nestjs-api`; diverge do padrão de testes do projeto; nova dependência.

### Option C: e2e depende do container `video-worker` em execução e faz polling
- **Pros:** cobre o caminho de produção inteiro, entrypoint incluso.
- **Cons:** não determinístico (o worker real pode consumir jobs de outras suítes); testes falham se o worker não estiver no ar; difícil isolar.

**Recommendation:** **Option A** — reaproveita a convenção existente (infra do Compose compartilhada + `--runInBand`) e mantém os testes determinísticos, exercitando Redis, storage e FFmpeg reais.

**Decision:** A (Compose + recursos de teste isolados + processor in-process)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Tecnologia de fila | A (BullMQ + Redis via `@nestjs/bullmq`) | **A** |
| TD-02 | Backend | Modelo de execução do worker | A (mesmo codebase, entrypoint e container próprios) | **A** |
| TD-03 | Backend | Imagem local do object storage | A (MinIO Chainguard fixado por digest) | **A** |
| TD-04 | Backend | Cliente S3 e endpoints de assinatura | A (AWS SDK v3 + `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT`) | **A** |
| TD-05 | Backend | Organização de buckets e chaves | A (bucket único privado, prefixo `videos/{videoId}/`) | **A** |
| TD-06 | Cross-layer | Protocolo de upload de até 10GB | A (S3 multipart com URLs pré-assinadas por parte) | **A** |
| TD-07 | Cross-layer | Gatilho do processamento | A (`complete` explícito via API publica o job) | **A** |
| TD-08 | Backend | Limites e formatos aceitos | A (mp4/webm, ≤ 10 GiB, sem transcodificação) | **A** |
| TD-09 | Cross-layer | URL única por vídeo | B (ID público base62 de 11 chars + índice único) | **B** |
| TD-10 | Cross-layer | Entrega de streaming e download | A (URL pré-assinada GET retornada em JSON) | **A** |
| TD-11 | Cross-layer | Acesso a stream/download nesta fase | A (somente dono, somente `ready`) | **A** |
| TD-12 | Backend | Modelo de status do vídeo | B (enum de processamento; publicação ortogonal) | **B** |
| TD-13 | Backend | Falha e retentativa | A (3 tentativas exponenciais + `UnrecoverableError`) | **A** |
| TD-14 | Backend | Integração FFmpeg/ffprobe | A (binários da distro via `child_process`) | **A** |
| TD-15 | Backend | Acesso do worker ao arquivo | A (FFmpeg lê URL pré-assinada via HTTP Range) | **A** |
| TD-16 | Repo-wide | Testes com infra real | A (Compose + recursos de teste + processor in-process) | **A** |

---

## Notes for downstream pipeline

- **Dependências entre TDs:** TD-02, TD-07 e TD-13 dependem de TD-01; TD-07 depende de TD-06; TD-10 depende de TD-04 e TD-11; TD-15 depende de TD-04 e TD-14; TD-16 depende de TD-01, TD-02, TD-03 e TD-14. As recomendações formam um conjunto coerente — se TD-01 mudar para B/C, revisitar TD-02, TD-07, TD-13 e TD-16.
- **Herdado (não reaberto):** guard JWT global e `@Public()` (`phase-02-auth/TD-02`), envelope de erro via filtro de domínio (`phase-02-auth/TD-07`), class-validator nos DTOs (`phase-02-auth/TD-06`), validação de env por Joi com `registerAs` (`phase-01-configuracao-base/TD-02..TD-04`), throttler (`phase-02-auth/TD-08`), OpenAPI via `@nestjs/swagger` (`openapi-docs-nestjs/TD-01`). O worker atualizar o banco diretamente é dado pelo diagrama C4 (`Worker → Database: Updates`).
- **Chaves de env novas implicadas** (conjunto canônico a fixar no `/plan-build`, mesmo contrato schema Joi + `compose.yaml` + `.env.example`): `REDIS_HOST`, `REDIS_PORT`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`. Hosts internos usam o nome do serviço Compose (regra de Docker Networking).
- **Itens deliberadamente não promovidos a TD** (resolvidos pelo `implement` com best-practices e código vizinho): frame escolhido para o thumbnail e formato (sugestão: JPEG em ~10% da duração, limitado ao fim do vídeo); provisionamento do bucket (container `minio-client` de init ou `CreateBucket` idempotente no boot); CORS do storage expondo `ETag`; healthchecks dos novos serviços; nomes de rotas (seguem as REST conventions do projeto); concorrência do worker.
- **Fora do escopo das capacidades, registrar como tarefa futura:** limpeza de rascunhos abandonados e multipart incompletos (o próprio storage expira uploads multipart obsoletos, mas o registro `draft` permanece), reprocessamento manual (TD-13 C), transcodificação/HLS (TD-08 C, TD-10 C).
- **Data Model** (para `/plan-build`): a tabela `videos` deve conter, no mínimo pelo enunciado, id, canal dono (`channel_id` FK → `channels`), título, status (TD-12), `public_id` (TD-09), chaves de storage do arquivo e do thumbnail (TD-05), duração e metadados (TD-14), além de `upload_id` do multipart (TD-06), tamanho/MIME declarados (TD-08) e motivo de falha (TD-13). Título no pré-cadastro: a definir no plano (ex.: nome do arquivo como padrão), já que a edição de título é da Fase 04.

Sources consulted during research:

- [NestJS — Queues (`@nestjs/bullmq`)](https://docs.nestjs.com/techniques/queues) — `BullModule.forRoot`/`registerQueue`, `@Processor` + `WorkerHost`, processors sandboxed sem DI.
- [BullMQ — Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs) — `attempts`, `backoff` fixed/exponential/custom, comportamento ao esgotar tentativas.
- Registry npm (2026-11-03): `@nestjs/bullmq@12.0.0`, `bullmq@6.5.4`, `pg-boss@12.38.0`, `@golevelup/nestjs-rabbitmq@9.1.1`, `@aws-sdk/client-s3@3.1161.0`, `@tus/server@2.4.7`, `nanoid@6.0.2` (`type: module`).
- [AWS S3 — Uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html) — PUT único até 5 GB; multipart recomendado para objetos grandes.
- [AWS S3 — Multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) — 10.000 partes, 5 MiB–5 GiB por parte.
- [minio/minio (GitHub)](https://github.com/minio/minio) — repositório arquivado em 25/04/2026; community edition somente como código-fonte, sem binários.
- [Chainguard — MinIO containers](https://www.chainguard.dev/unchained/secure-and-free-minio-chainguard-containers) — imagens `cgr.dev/chainguard/minio` e `minio-client` gratuitas.
- [RustFS — S3 protocol docs](https://docs.rustfs.com/administration/protocols/s3) — suporte a multipart e presigned.
- [fluent-ffmpeg (npm)](https://npmjs.com/package/fluent-ffmpeg) — aviso de deprecação.
- Docker Hub / registries (2026-11-03): `minio/minio` e `quay.io/minio/minio` indisponíveis; `cgr.dev/chainguard/minio`, `rustfs/rustfs:1.0.4`, `chrislusf/seaweedfs`, `redis:8.8` disponíveis.
