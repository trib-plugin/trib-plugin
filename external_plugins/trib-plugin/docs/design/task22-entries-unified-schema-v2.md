# Task #22 — Unified `entries` Schema v2 (Final)

**Status**: Approved. Ready for implementation.
**Owner**: lead
**Reviewers**: GPT5.4 (bridge), Opus worker (native)
**Date**: 2026-04-15

---

## 1. Background

Current `memory.sqlite` schema fragments knowledge across 17+ tables
(`episodes`, `classifications`, `memory_chunks`, `core_memory`,
`memory_vectors`, `vec_memory`, plus FTS shadows and dormant tables) with
duplicated metadata, drift between dual vector stores, and multi-user
residue columns inappropriate for a personal-use deployment.

This v2 design supersedes v1 and reflects the consolidated decisions
reached after both reviewer rounds (Approve-with-changes from Opus, Reject
from GPT5.4) and a series of user-driven simplifications.

## 2. Goals

1. Single canonical entity table with self-referential chunk grouping.
2. Compact representation: drop multi-user residue, remove redundant
   metadata, collapse dual vector storage.
3. Preserve raw originals; never destroy a source line.
4. Quantitative score with decoupled `grade` and `decay_rate`.
5. Reduce table count from 17+ to 4 (entries / vec_entries / entries_fts
   / meta).
6. No migration. Wipe and backfill 7 days of transcript history.

## 3. Final Schema

### 3.1 `entries` (single unified table — 15 columns)

| Column           | Type    | NN | Default      | Purpose                                                                                                       |
|------------------|---------|----|--------------|---------------------------------------------------------------------------------------------------------------|
| `id`             | INTEGER | -  | PK           | Identifier                                                                                                    |
| `ts`             | INTEGER | ✓  | -            | Unix milliseconds                                                                                             |
| `role`           | TEXT    | ✓  | -            | `user` / `assistant` / `system`                                                                               |
| `content`        | TEXT    | ✓  | -            | Raw original content. Always preserved.                                                                       |
| `session_id`     | TEXT    | -  | NULL         | Claude session UUID for transcript entries; Discord channel id for channel entries.                           |
| `chunk_root`     | INTEGER | -  | NULL         | Self-FK. NULL = unclassified. `=id` = root. Other id = member.                                                 |
| `is_root`        | INTEGER | -  | 0            | 1 if this entry is a chunk root. Mirrors `chunk_root = id`.                                                    |
| `element`        | TEXT    | -  | NULL         | Short subject label, 5–10 words. Root only.                                                                    |
| `category`       | TEXT    | -  | NULL         | One of 8: see section 5. Root only.                                                                            |
| `summary`        | TEXT    | -  | NULL         | Refined synthesis of the chunk's member entries (1–3 paragraphs). Root only.                                   |
| `status`         | TEXT    | -  | NULL         | `active` / `pending` / `demoted` / `processed` / `archived`. Root only. NULL = classified, not yet evaluated.  |
| `score`          | REAL    | -  | NULL         | Cached `grade × decay`. See section 5.                                                                         |
| `last_seen_at`   | INTEGER | -  | NULL         | Decay base. Updated on mention or retrieval hit.                                                              |
| `embedding`      | BLOB    | -  | NULL         | float32 vector of `summary`. Root only.                                                                       |
| `content_hash`  | TEXT    | -  | NULL         | SHA-256 of `summary`. Skip re-embedding when unchanged.                                                         |

**Constraints**

```sql
UNIQUE (ts, role)            -- backfill dedupe (no source_ref)
CHECK (
  (chunk_root IS NULL AND is_root = 0)
  OR (is_root = 1 AND chunk_root = id)
  OR (is_root = 0 AND chunk_root IS NOT NULL AND chunk_root != id)
)
CHECK (role IN ('user','assistant','system'))
CHECK (category IS NULL OR category IN
  ('rule','constraint','decision','fact','goal','preference','task','issue'))
CHECK (status IS NULL OR status IN
  ('active','pending','demoted','processed','archived'))
```

**Indexes**

```sql
CREATE INDEX idx_entries_chunk_root      ON entries(chunk_root);
CREATE INDEX idx_entries_ts_desc         ON entries(ts DESC);
CREATE INDEX idx_entries_session         ON entries(session_id);
CREATE INDEX idx_entries_root_status_score
  ON entries(status, score DESC) WHERE is_root = 1;
CREATE INDEX idx_entries_root_category
  ON entries(category, status) WHERE is_root = 1;
```

### 3.2 `vec_entries` (sqlite-vec virtual, derived index)

```sql
CREATE VIRTUAL TABLE vec_entries USING vec0(embedding float[1024])
```

- `rowid = entries.id` directly. No type-prefix encoding.
- Maintained write-through from `entries.embedding` updates.
- `entries.embedding` is the canonical store. `vec_entries` may be
  `DROP`/`REBUILD` at any time without data loss.

### 3.3 `entries_fts` (sqlite-fts5)

```sql
CREATE VIRTUAL TABLE entries_fts USING fts5(
  content, element, summary,
  content='entries',
  content_rowid='id',
  tokenize='trigram'
)
```

- **Tokenizer**: `trigram` for Korean coverage. Mandatory.
- 2-character query terms must use a `LIKE`-based fallback path in
  retrieval code (FTS5 `trigram` cannot match terms shorter than 3 chars).
- INSERT/UPDATE/DELETE triggers on `entries` keep FTS in sync.

### 3.4 `meta` (operational KV)

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

Convention: dotted keys.
`embedding.current_model`, `embedding.current_dims`, `embedding.index_version`,
`state.transcript_offsets`, `state.cycle2_last_chunk_id`,
`boot.schema_bootstrap_complete`, `cycle.last_run_at`.

## 4. Removed / Consolidated

| Old artefact                                      | Disposition                                                       |
|---------------------------------------------------|-------------------------------------------------------------------|
| `episodes`                                        | Merged into `entries`                                             |
| `classifications`                                 | Absorbed into root entries (element/category/summary cols)        |
| `memory_chunks`                                   | Absorbed via `chunk_root` self-FK                                  |
| `core_memory`                                     | Absorbed via `status` + `score` family on root entries            |
| `memory_vectors`                                  | Absorbed into `entries.embedding` + `content_hash`                |
| `vec_memory`                                      | Replaced by `vec_entries` (rowid = entries.id direct)             |
| `classifications_fts`, `memory_chunks_fts`        | Unified into `entries_fts`                                        |
| `memory_meta`                                     | Renamed to `meta`                                                  |
| `proactive_sources`                               | Dropped. Proactive picks query entries by category/grade/score.   |
| `semantic_cache`                                  | Dropped. Code + call sites fully removed.                          |
| `user_model` (legacy 228 rows)                    | Dropped. Code + call sites fully removed.                          |
| `classification_stats` (dormant)                  | Dropped.                                                           |
| `documents` (dormant)                             | Dropped.                                                           |
| `pending_embeds` (dormant)                        | Dropped. Use in-memory queue if needed.                            |

Removed columns: `backend`, `channel_id`, `user_id`, `user_name`, `day_key`,
`created_at`, `kind`, `classified`, `source_ref`, `embedding_model`, `dims`,
`confidence`, `topic`, `mention_count`, `retrieval_count`,
`last_retrieved_at`, `promoted_at`, `last_mentioned_at`, `state`, `pinned`,
`hit_count`, `skip_count`.

## 5. Quantitative Score Model

```
ageDays      = (now - last_seen_at) / 86_400_000
adjusted_age = ageDays * decay_rate[category]
decay        = 1 / (1 + adjusted_age / 30) ^ 0.3
score        = grade[category] * decay
```

Properties:

- Mention or retrieval hit → set `last_seen_at = now` → `decay = 1.0` reset.
- `decay_rate = 0.0` → `adjusted_age = 0` → permanent (no decay).
- `decay_rate` larger → faster decay.
- `grade` scales the absolute score ceiling.
- `score` is cached on `entries.score` for ranking. Recomputed by cycles
  and on retrieval write-back.
- `last_seen_at` fallback: `COALESCE(last_seen_at, ts)` to prevent NaN.

### 5.1 Category metadata (code constant `CATEGORY_META`)

| category     | grade | decay_rate | Notes                                                 |
|--------------|------:|-----------:|-------------------------------------------------------|
| `rule`       | 2.0   | 0.0        | Permanent system rules + identity + operating policy. |
| `constraint` | 1.9   | 0.06       | Hard limits (security/cost/time).                     |
| `decision`   | 1.8   | 0.15       | Explicit user-agreed decisions.                       |
| `fact`       | 1.6   | 0.25       | Verified facts + observed patterns.                   |
| `goal`       | 1.5   | 0.30       | Long-term goals/direction.                            |
| `preference` | 1.4   | 0.35       | User preferences/taste.                               |
| `task`       | 1.1   | 0.45       | Active or pending work.                               |
| `issue`      | 1.0   | 0.50       | Known issues, bugs, incidents.                        |

- `grade` ratio cap: 2.0 / 1.0 = 2.0.
- `decay_rate` absolute range: 0.0 ~ 0.5.

### 5.2 Score examples (60 days since last_seen_at)

| category   | adjusted_age | decay | score |
|------------|-------------:|------:|------:|
| rule       | 0            | 1.00  | 2.00  |
| decision   | 9            | 0.91  | 1.64  |
| fact       | 15           | 0.86  | 1.38  |
| task       | 27           | 0.79  | 0.87  |
| issue      | 30           | 0.79  | 0.79  |

## 6. Runtime Operations

| Operation             | Behaviour                                                                                                                          |
|-----------------------|------------------------------------------------------------------------------------------------------------------------------------|
| Transcript ingest     | INSERT into `entries` (kind=`message` only). Other kinds (schedule-send/event-inject/voice) are NOT injected.                      |
| Backfill              | `backfillProject` uses `transcript_offsets`. No file `limit` cap. UNIQUE(ts, role) provides dedupe.                                |
| cycle1 classification | SELECT unclassified roots-to-be (chunk_root IS NULL) → LLM groups + emits element/category/summary → UPDATE root, UPDATE members.  |
| Embedding             | Embed `summary` only (root entries). Skip when `content_hash` matches.                                                             |
| cycle2 promotion      | Re-evaluate classified roots → set `status='active'/'pending'/'demoted'/'processed'/'archived'` + recompute `score`.               |
| Search                | vec_entries KNN → rowid==entries.id → entries direct join. Grouping by `chunk_root` to surface members.                            |
| Vector rebuild        | `DROP vec_entries; CREATE; INSERT SELECT id, embedding FROM entries WHERE embedding IS NOT NULL`.                                  |

## 7. Concurrency & Sizing

| Setting               | Value                              | Surface                 |
|-----------------------|------------------------------------|-------------------------|
| `batch_size`          | 50 (default; user-configurable)    | `memory-config.json`    |
| `BACKFILL_CONCURRENCY`| 3 (constant; not user-configurable)| code constant           |
| Other concurrency     | 1 (serial). cycle1/cycle2/rebuild/prune always single-threaded. | code              |
| `cycle1.interval`     | `10m`                              | `memory-config.json`    |
| `cycle2.interval`     | `1h`                               | `memory-config.json`    |

## 8. Initial Data Strategy

- **No migration.** All existing tables are dropped.
- Wipe `memory.sqlite` (or recreate file) under the new schema.
- Backfill: `backfill.mode = 'if-empty'`, `backfill.window = '7d'`,
  `backfill.scope = 'all'`. Limit removed.
- After ingest, cycle1 (10 min interval) progressively classifies entries.
- cycle2 (1h interval) progressively promotes to `active`.
- Expected ramp-up: a few hours to a day before recap is meaningfully populated.

## 9. Pre-requisite (must complete before schema cutover)

**Bench isolation** — `src/memory/bench/retrieval-eval.mjs` must redirect
its `DATA_DIR` to a sandboxed location (e.g. `os.tmpdir() +
'/trib-plugin-bench-data'`) and only fall back to production
`CLAUDE_PLUGIN_DATA` behind an explicit `--use-shared-data` flag.

Without this, any new schema gets re-contaminated by the next bench run.

## 10. Performance Expectations (revised after GPT review)

| Metric                | Estimate         |
|-----------------------|------------------|
| DB size               | -10% to -30%    (BLOB vectors + removed metadata duplication; trigram FTS now covers content+summary) |
| Hybrid search latency | maintained to -25% (rowid direct join, BLOB cosine) |
| LLM classification    | -40% to -70% if chunk grouping reduces calls per N member entries |
| Core promotion        | UPDATE-in-place vs INSERT — meaningful but small absolute win |
| Drift risk            | Eliminated (single canonical store)                |

These are conservative estimates. Final numbers should be measured
against a prototype.

## 11. Code Impact (transition surface)

In-scope modules:

- `src/memory/lib/memory.mjs` — schema definitions, INSERT/SELECT, vector ops
- `src/memory/lib/memory-cycle.mjs` — cycle1/cycle2, classification chain
- `src/memory/lib/memory-recall-store.mjs` — search hot path
- `src/memory/lib/memory-retrievers.mjs` — recall structures
- `src/memory/lib/memory-maintenance-store.mjs` — reset/prune
- `src/memory/index.mjs` — worker entry, `memory` MCP tool actions
- `hooks/session-start.cjs` — recap injection
- `setup/setup-server.mjs` — admin endpoints touching `core_memory` /
  `proactive_sources`
- `scripts/skill-suggest.mjs` — uses memory schema
- `src/shared/llm/semantic-cache.mjs` — to be deleted

## 12. Open Items (deferred, non-blocking)

- Future source extension (voice/image) — schema can extend role/kind
  later if needed.
- `proactive_sources` re-introduction policy (Task #23 hold).
- Wide row monitoring once live to confirm page overflow is acceptable.

## 13. Implementation Order

1. **Bench isolation** PR (`retrieval-eval.mjs` DATA_DIR isolation).
2. v2 design doc final approval.
3. Schema implementation in `src/memory/lib/memory.mjs` (init function).
4. Refactor `memory-cycle.mjs` for `entries` model + chunk grouping prompt.
5. Refactor recall/retriever/maintenance modules.
6. Refactor `hooks/session-start.cjs` + `setup-server.mjs`.
7. Delete `semantic_cache.mjs` + `user_model` references.
8. Wipe DB + bring up new schema + run backfill (window=7d).
9. Verify recap, search, cycle1/cycle2 progression.
10. Push.
