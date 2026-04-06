# Search Redesign Plan

## Goal
Redesign search_memories as a smart search tool with intuitive parameters and semantic-first results.

## Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `query` | string (optional) | Search text. Omit for recent conversations. | - |
| `period` | string (optional) | Time range: `last`, `24h`, `3d`, `7d`, `30d`, or date `2026-04-05` | - |
| `sort` | string | `date` (newest first) or `importance` (high confidence first) | `date` |
| `limit` | number | Max results | 20 |

## Search Priority (Smart Fallback)

1. **Chunks** — LLM-refined semantic segments (highest quality)
2. **Classifications** — Tagged rules, decisions, goals, incidents
3. **Episodes** — Raw conversation (fallback when semantic content insufficient)

### Flow
```
Input (query + period + sort + limit)
  → 1st pass: search chunks + classifications (semantic)
  → Enough results? → return
  → Not enough? → 2nd pass: search episodes (fallback)
  → Merge: semantic results first, episodes fill remaining
```

## Usage Examples

- `query="reranker config"` → semantic search for reranker-related content
- `period="last"` → last session conversations (limit 20)
- `period="24h"` → everything from last 24 hours
- `query="reranker", period="3d"` → reranker mentions within 3 days
- No params → most recent 20 items
- `sort="importance"` → highest confidence classifications first

## Migration from Current API

| Current | New |
|---------|-----|
| `session="last"` | `period="last"` |
| `session="current"` | `period="24h"` or no period |
| `date="2026-04-05"` | `period="2026-04-05"` |
| `sort="relevance"` | Removed (semantic search is inherently relevance-based) |
| `sort="date"` | `sort="date"` |
| `sort="asc"` | Removed |
| `queries=[...]` | Keep batch mode |

## TODO
- [ ] Unify session/date into period parameter
- [ ] Add importance sort (by classification confidence + retrieval_count)
- [ ] Implement smart fallback (semantic first, episode fallback)
- [ ] Update tool schema and description
- [ ] Update MCP instructions
- [ ] Backward compatibility: keep old params working internally
