---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-03T20:19:43-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-03T20:15:55-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Pré-cadastro: dados exigidos no início do upload (título) não definidos"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-2
    status: resolved
    summary: "Conjunto de metadados extraídos e forma de persistência não definidos"
    resolved_by: phase-03-videos/TD-14
  - id: AMB-3
    status: resolved
    summary: "Thumbnail: frame, formato e dimensões não definidos"
    resolved_by: phase-03-videos/TD-14
  - id: AMB-4
    status: resolved
    summary: "Upload cancelado/abandonado: comportamento do rascunho não definido"
    resolved_by: phase-03-videos/TD-06
  - id: AMB-5
    status: resolved
    summary: "Leitura do vídeo (status/metadados) pelo dono: Fase 03 ou Fase 04?"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

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

- **AMB-1** _(resolved_by phase-03-videos/TD-12)_ — Pré-cadastro: título opcional, padrão = nome do arquivo sem extensão; cliente informa nome do arquivo, MIME e tamanho (Revision em TD-12).
- **AMB-2** _(resolved_by phase-03-videos/TD-14)_ — Metadados: colunas tipadas (duração, largura, altura, codecs de vídeo/áudio, tamanho real) + `jsonb` com o restante do ffprobe (Revision em TD-14).
- **AMB-3** _(resolved_by phase-03-videos/TD-14)_ — Thumbnail: JPEG do frame em 10% da duração (piso 0 s), largura máx. 1280px mantendo proporção (Revision em TD-14).
- **AMB-4** _(resolved_by phase-03-videos/TD-06)_ — Endpoint de cancelamento do upload (`AbortMultipartUpload` + remoção do `draft`); limpeza de abandonados vira tarefa futura (Revision em TD-06).
- **AMB-5** _(resolved_by phase-03-videos/TD-11)_ — Fase 03 expõe só `GET` de um vídeo do próprio dono (status, metadados, `public_id`, thumbnail via URL assinada); listagem fica para a Fase 04 (Revision em TD-11).
