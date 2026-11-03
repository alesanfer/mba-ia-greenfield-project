---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 5
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-03T19:59:37-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-03T19:51:01-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Pré-cadastro: dados exigidos no início do upload (título) não definidos"
  - id: AMB-2
    status: open
    summary: "Conjunto de metadados extraídos e forma de persistência não definidos"
  - id: AMB-3
    status: open
    summary: "Thumbnail: frame, formato e dimensões não definidos"
  - id: AMB-4
    status: open
    summary: "Upload cancelado/abandonado: comportamento do rascunho não definido"
  - id: AMB-5
    status: open
    summary: "Leitura do vídeo (status/metadados) pelo dono: Fase 03 ou Fase 04?"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — A capacidade "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" não define quais dados o cliente informa ao iniciar o upload. `phase-03-videos/TD-08` fixa MIME e tamanho declarados, mas o vídeo precisa de um título (exigido pelo modelo de persistência), e a edição de título é da Fase 04 ("Edição das informações do vídeo: título, descrição, categoria e thumbnail customizada"). Explicit choice: (a) o título é obrigatório no início do upload; (b) o título é opcional, com padrão derivado do nome do arquivo; (c) o título é derivado sempre do nome do arquivo, sem input do cliente até a Fase 04.
- **AMB-2** — A capacidade "Processamento automático do vídeo após upload (extração de duração e metadados)" não especifica *quais* metadados além da duração, nem como são persistidos. `phase-03-videos/TD-14` fixa o ffprobe com saída JSON, mas o Data Model do plano depende dessa escolha. Explicit choice: (a) colunas tipadas para um conjunto fixo (ex.: duração, largura, altura, codec de vídeo/áudio, bitrate, fps) mais o tamanho real do arquivo; (b) duração tipada + JSON bruto do ffprobe em coluna `jsonb`; (c) colunas tipadas para o conjunto principal + `jsonb` com o restante.
- **AMB-3** — A capacidade "Geração automática de thumbnail a partir de um frame do vídeo" não define qual frame, formato nem dimensões. `phase-03-videos/TD-05` fixa só a chave `videos/{videoId}/thumbnail.jpg` (o que implica JPEG). Sem isso, os testes não têm um resultado esperado verificável e o worker não tem regra para vídeos muito curtos. Explicit choice: posição do frame (ex.: segundo fixo, % da duração com limite para vídeos curtos) e dimensões (resolução original vs. largura fixa mantendo a proporção).
- **AMB-4** — As capacidades de upload/pré-cadastro implicam casos de borda que nenhuma TD trata: o cliente cancela o upload no meio, ou abandona-o sem nunca chamar o `complete` (`phase-03-videos/TD-07` Option A cria esse estado). `phase-03-videos/TD-12` só define as transições `draft→processing→ready|failed`. Explicit choice: (a) a Fase 03 inclui um endpoint de cancelamento (`AbortMultipartUpload` + remoção ou marcação do rascunho), e a limpeza automática de abandonados fica para tarefa futura; (b) nada de cancelamento/limpeza nesta fase — rascunhos órfãos ficam como risco documentado; (c) cancelamento + job periódico de limpeza já nesta fase.
- **AMB-5** — Fronteira com a Fase 04. Para "Processamento automático…" e o ciclo de status (`phase-03-videos/TD-12`) serem observáveis, o dono precisa consultar o vídeo (status, duração, `public_id`). Porém o "Painel de gerenciamento de vídeos do canal" é da Fase 04. Não está claro se a Fase 03 expõe uma leitura do vídeo. Explicit choice: (a) a Fase 03 expõe apenas `GET` de um vídeo do próprio dono (status + metadados + `public_id`), e a listagem fica para a Fase 04; (b) a Fase 03 não expõe leitura — o status só é observável no banco e nos testes; (c) a Fase 03 expõe leitura individual e listagem dos vídeos do dono.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI Inventory em estado deferred — check não se aplica.)_

## Resolved Issues

_No issues resolved yet._
