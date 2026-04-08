# trib-memory

Persistent memory MCP plugin for Claude Code. Stores episodes as source of truth, extracts classifications via LLM, and serves hybrid RAG retrieval.

## Architecture

```text
episodes (source of truth)
  -> cycle1: LLM classification extraction (topic, element, importance)
  -> cycle2 (sleep): dedup + core memory promotion + context.md refresh + embedding refresh
```

> cycle3 (weekly decay rebuild) is planned but not yet implemented.
> context.md refresh currently runs as part of cycle2.

## Data Model

- **episodes** — raw conversation logs (role, content, timestamp)
- **classifications** — extracted metadata (classification, topic, element, state)
- **core_memory** — promoted long-term items (50 active cap, LLM-evaluated)
- **context.md** — generated output from active core_memory items

### Classification Schema

```json
{
  "classification": "work",
  "topic": "auto binding",
  "element": "discord",
  "state": "needs review"
}
```

### Importance Tags (Decay Modulation)

| Tag | Factor | Decay Speed |
|-----|--------|-------------|
| `rule` | 0.0 | Never |
| `directive` | 0.1 | Almost never |
| `decision` | 0.2 | Very slow |
| `preference` | 0.075 | Very slow |
| `incident` | 0.125 | Slow |
| (default) | 1.0 | Normal |
| `transient` | 1.5 | Fast |

Decay formula: `decay = 1 / (1 + ageDays / 30) ^ 0.3`

## Retrieval (Hybrid RAG)

Three-signal search with post-ranking adjustments:

```text
base_score = RRF_merge(keyword_FTS, vector_KNN, k=60)
final_score = base_score * importance * time_factor * role * type
```

- **Sparse**: FTS5 full-text search (BM25)
- **Dense**: bge-m3 embeddings (1024 dims) via Xenova/Transformers.js
- **Fusion**: Reciprocal Rank Fusion (k=60)
- **Temporal**: date range filtering with relative date parsing

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_memories` | Hybrid search with period/sort/limit. Shortcuts: "stats", "rules", "decisions", "goals" |
| `memory_cycle` | Actions: `status`, `sleep`, `flush`, `rebuild`, `rebuild_classifications`, `prune`, `cycle1`, `backfill` |

## Injection Paths

| Path | Status | Description |
|------|--------|-------------|
| SessionStart hook | **Working** | Injects active core_memory items once at session start |
| On-demand recall | **Working** | `search_memories` MCP tool via recall skill |

## Embedding Policy

Delta updates only — no full rebuilds:
- New episode → embed that episode
- New classification → embed that row
- Correction → spot re-embed changed rows

## Worker Host Pattern

```text
server -> fork(worker) -> IPC request -> worker spawn(codex/claude/...) -> IPC response
```

Isolates CLI instability from the main MCP server process.

## Key Files

| File | Purpose |
|------|---------|
| `lib/memory.mjs` | Storage, search, context generation |
| `lib/memory-cycle.mjs` | cycle1/cycle2 pipeline |
| `lib/memory-score-utils.mjs` | Decay formula, scoring |
| `services/memory-service.mjs` | MCP + HTTP entry point |
| `hooks/session-start.cjs` | Core memory injection at session start |

## Future Work

- [ ] cycle3: periodic decay application + context.md rebuild (separate from cycle2)
- [ ] Memory security scanning (prompt injection, credential leak detection)

## Notes

- Default embedding: `Xenova/bge-m3` (local ONNX, auto-downloaded)
- Core memory active cap: 50 items
- Decay computed at search time, not stored in DB
