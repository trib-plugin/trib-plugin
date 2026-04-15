# Task #22 — Unified `entries` Schema v3 (Final)

**Status**: Awaiting final GPT review. Ready for implementation upon approval.
**Owner**: lead
**Reviewers**: GPT5.4 (bridge) — v1 Reject, v2 Approve-with-changes; Opus worker — v1 Approve-with-changes
**Date**: 2026-04-15
**Supersedes**: v1, v2

---

## 1. Background

Current `memory.sqlite` schema fragments knowledge across 17+ tables with
duplicated metadata, drift between dual vector stores, and multi-user
residue columns inappropriate for a personal-use deployment.

v3 incorporates all blockers identified in v2 GPT review (dedupe key
safety, chunk_root FK integrity, score boundary handling, vector dimension
parameterization) plus nice-to-haves (root-only CHECK, root selection
rule, session+ts index, expression cleanup).

## 2. Goals

1. Single canonical entity table with self-referential chunk grouping.
2. Strong dedupe via stable `source_ref` (resurrected from current schema).
3. Enforced referential integrity for `chunk_root` (FK + ON DELETE SET NULL).
4. Bounded, well-defined `score` formula with explicit boundary handling.
5. Vector dimension parameterized by `meta.embedding.current_dims`.
6. Reduce table count from 17+ to 4.
7. No migration. Wipe + 7 days transcript backfill.

## 3. Final Schema

### 3.1 `entries` (16 columns)

| Column         | Type    | NN | Default | Purpose                                                                                          |
|----------------|---------|----|---------|--------------------------------------------------------------------------------------------------|
| `id`           | INTEGER | -  | PK      | Identifier                                                                                       |
| `ts`           | INTEGER | ✓  | -       | Unix milliseconds                                                                                |
| `role`         | TEXT    | ✓  | -       | `user` / `assistant` / `system`                                                                  |
| `content`      | TEXT    | ✓  | -       | Raw original content. Always preserved.                                                          |
| `source_ref`   | TEXT    | ✓  | -       | Stable line key. `transcript:{file_uuid}#{line_idx}` / `discord:{message_id}` / `manual:{uuid}` |
| `session_id`   | TEXT    | -  | NULL    | Claude session UUID (transcript) or Discord channel id                                           |
| `chunk_root`   | INTEGER | -  | NULL    | Self-FK. NULL = unclassified. `=id` = root. Other id = member                                    |
| `is_root`      | INTEGER | ✓  | 0       | 1 if root. Mirrors `chunk_root = id`                                                              |
| `element`      | TEXT    | -  | NULL    | Short subject label (5–10 words). Root only                                                       |
| `category`     | TEXT    | -  | NULL    | One of 8 (sec 5.1). Root only                                                                     |
| `summary`      | TEXT    | -  | NULL    | Refined synthesis (1–3 paragraphs). Root only                                                     |
| `status`       | TEXT    | -  | NULL    | NULL = classified, not yet evaluated. Or `active`/`pending`/`demoted`/`processed`/`archived`     |
| `score`        | REAL    | -  | NULL    | Cached `grade × decay` (root only)                                                                |
| `last_seen_at` | INTEGER | -  | NULL    | Decay base. Updated on root or via member hit (writes to root)                                   |
| `embedding`    | BLOB    | -  | NULL    | float32 vector of `summary`. Root only                                                           |
| `summary_hash` | TEXT    | -  | NULL    | SHA-256 of `summary`. Skip re-embedding when unchanged                                            |

**Constraints**

```sql
UNIQUE (source_ref)            -- primary dedupe (stable across re-ingest)
FOREIGN KEY (chunk_root)
  REFERENCES entries(id)
  ON DELETE SET NULL           -- root deletion makes members unclassified again

CHECK (role IN ('user','assistant','system'))

CHECK (
  (chunk_root IS NULL AND is_root = 0)
  OR (is_root = 1 AND chunk_root = id)
  OR (is_root = 0 AND chunk_root IS NOT NULL AND chunk_root != id)
)

CHECK (
  is_root = 1
  OR (element IS NULL
      AND category IS NULL
      AND summary IS NULL
      AND status IS NULL
      AND score IS NULL
      AND embedding IS NULL
      AND summary_hash IS NULL)
)

CHECK (category IS NULL OR category IN
  ('rule','constraint','decision','fact','goal','preference','task','issue'))

CHECK (status IS NULL OR status IN
  ('active','pending','demoted','processed','archived'))
```

**Indexes**

```sql
CREATE INDEX idx_entries_chunk_root ON entries(chunk_root);
CREATE INDEX idx_entries_ts_desc    ON entries(ts DESC);
CREATE INDEX idx_entries_session_ts ON entries(session_id, ts DESC);
CREATE INDEX idx_entries_root_status_score
  ON entries(status, score DESC) WHERE is_root = 1;
CREATE INDEX idx_entries_root_category
  ON entries(category, status) WHERE is_root = 1;
```

### 3.2 `vec_entries` (sqlite-vec virtual; dimension parameterized)

```sql
-- DDL emitted at init using meta.embedding.current_dims
CREATE VIRTUAL TABLE vec_entries USING vec0(embedding float[<dims>])
```

- `rowid = entries.id` directly. No type-prefix encoding.
- Maintained write-through from `entries.embedding` updates.
- `entries.embedding` is canonical. `vec_entries` may be dropped/rebuilt.
- **Embedding model change procedure**:
  1. UPDATE `meta` set new `embedding.current_model` / `current_dims`.
  2. UPDATE `entries` set `embedding = NULL`, `summary_hash = NULL` for all roots.
  3. DROP `vec_entries`. CREATE with new dimension.
  4. Background re-embedding via cycle1 incremental.

### 3.3 `entries_fts` (sqlite-fts5)

```sql
CREATE VIRTUAL TABLE entries_fts USING fts5(
  content, element, summary,
  content='entries',
  content_rowid='id',
  tokenize='trigram'
)
```

- `tokenize='trigram'` for Korean coverage. Mandatory.
- Queries with terms shorter than 3 chars must use a `LIKE`-based
  fallback path in retrieval code (FTS5 trigram cannot index 2-char
  terms). Acceptable cost: full scan on 2-char terms only.
- INSERT/UPDATE/DELETE triggers on `entries` keep FTS in sync.

### 3.4 `meta`

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

Convention (dotted keys):
- `embedding.current_model`, `embedding.current_dims`, `embedding.index_version`
- `state.transcript_offsets`, `state.cycle2_last_chunk_id`
- `boot.schema_bootstrap_complete`
- `cycle.last_run_at`

## 4. Removed / Consolidated

| Old artefact                                     | Disposition                                                |
|--------------------------------------------------|------------------------------------------------------------|
| `episodes`                                       | Merged into `entries`                                      |
| `classifications`                                | Absorbed into root entries                                 |
| `memory_chunks`                                  | Absorbed via `chunk_root` self-FK                           |
| `core_memory`                                    | Absorbed via `status` + `score` on root entries             |
| `memory_vectors`                                 | Absorbed into `entries.embedding` + `summary_hash`         |
| `vec_memory`                                     | Replaced by `vec_entries`                                  |
| `classifications_fts`, `memory_chunks_fts`       | Unified into `entries_fts`                                 |
| `memory_meta`                                    | Renamed to `meta`                                          |
| `proactive_sources`                              | Dropped. Proactive picks query entries by category/score   |
| `semantic_cache`                                 | Dropped. Code + call sites fully removed                   |
| `user_model` (legacy)                            | Dropped. Code + call sites fully removed                   |
| `classification_stats`, `documents`, `pending_embeds` (dormant) | Dropped                                       |

Removed columns: `backend`, `channel_id`, `user_id`, `user_name`, `day_key`,
`created_at`, `kind`, `classified`, `embedding_model`, `dims`, `confidence`,
`topic`, `mention_count`, `retrieval_count`, `last_retrieved_at`,
`promoted_at`, `last_mentioned_at`, `state`, `pinned`, `hit_count`, `skip_count`.

## 5. Quantitative Score Model

```
ageDays      = max(0, (now - COALESCE(last_seen_at, ts)) / 86_400_000)
adjusted_age = ageDays * decay_rate[category]
decay        = 1 / (1 + adjusted_age / 30) ^ 0.3
score        = min(grade[category], grade[category] * decay)
```

Boundary handling:

- `last_seen_at IS NULL` → fall back to `ts`.
- Future timestamps → `ageDays` floored to 0 (decay = 1.0, but clamped by grade).
- `score <= grade` always (no overshoot).

Reset rules:

- Mention or retrieval hit → set `last_seen_at = now` on the **root** entry.
- Member-level hits resolve to their root via `chunk_root`. Members have no
  `last_seen_at` of their own.
- `decay_rate = 0` → `adjusted_age = 0` → permanent.

`score` is cached on `entries.score` for ranking; recomputed by cycles
and on retrieval write-back.

### 5.1 Category metadata (code constant `CATEGORY_META`)

| category     | grade | decay_rate | Notes                                                     |
|--------------|------:|-----------:|-----------------------------------------------------------|
| `rule`       | 2.0   | 0.0        | Permanent system rules + identity + operating policy      |
| `constraint` | 1.9   | 0.06       | Hard limits (security/cost/time)                          |
| `decision`   | 1.8   | 0.15       | Explicit user-agreed decisions                            |
| `fact`       | 1.6   | 0.25       | Verified facts + observed patterns                        |
| `goal`       | 1.5   | 0.30       | Long-term goals/direction                                 |
| `preference` | 1.4   | 0.35       | User preferences/taste                                    |
| `task`       | 1.1   | 0.45       | Active or pending work                                    |
| `issue`      | 1.0   | 0.50       | Known issues, bugs, incidents                             |

- `grade` ratio cap: 2.0 / 1.0 = 2.0
- `decay_rate` absolute range: 0.0 ~ 0.5

### 5.2 LLM classification guide (chunk extraction prompt)

```
rule       — system rules, identity facts, operating policies (永久)
constraint — hard limits/forbidden (security, cost, time)
decision   — explicit decisions agreed with the user
fact       — verified facts, observed patterns, technical details
goal       — long-term goals, direction
preference — user taste, style preferences
task       — current/pending work items
issue      — known problems, bugs, incidents
```

When in doubt between `fact` vs `observation`-like text, prefer `fact`
when verified; use the same category — `fact` covers both.

## 6. Runtime Operations

| Operation                | Behaviour                                                                                                                                |
|--------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| Transcript ingest        | Read jsonl lines, INSERT into `entries` with `source_ref`. Only `role IN ('user','assistant')` ingested. `system` reserved for future.   |
| Backfill                 | `backfillProject` uses `state.transcript_offsets`. UNIQUE(source_ref) provides dedupe. No file `limit` cap.                              |
| cycle1 classification    | SELECT entries with `chunk_root IS NULL`, batch 50 → LLM groups + emits chunk metadata + chooses root (= MIN ts member of each chunk).   |
| Root selection           | **Earliest `ts` among the chunk's member candidates**. Deterministic across runs.                                                        |
| Embedding                | Embed `summary` only (root entries). Skip when `summary_hash` matches.                                                                   |
| cycle2 promotion         | Re-evaluate classified roots → set `status` + recompute `score`. Promotes/demotes/archives.                                              |
| Member hit               | Identify member's `chunk_root` → UPDATE root entry's `last_seen_at = now` and recompute root's `score`. Members carry no freshness.      |
| Search                   | vec_entries KNN → rowid==entries.id (root entries only) → entries direct join → optional member expansion via `chunk_root`.              |
| Vector rebuild           | `DROP vec_entries; CREATE VIRTUAL TABLE vec_entries USING vec0(embedding float[<current_dims>]); INSERT all root entries with embedding`. |
| Embedding model change   | See section 3.2 procedure.                                                                                                                |

## 7. Concurrency & Sizing

| Setting               | Value                              | Surface              |
|-----------------------|------------------------------------|----------------------|
| `batch_size`          | 50 (default; user-configurable)    | `memory-config.json` |
| `BACKFILL_CONCURRENCY`| 3                                  | code constant        |
| Other concurrency     | 1 (serial)                         | code                 |
| `cycle1.interval`     | `10m`                              | `memory-config.json` |
| `cycle2.interval`     | `1h`                               | `memory-config.json` |

## 8. Initial Data Strategy

- **No migration.** All existing tables are dropped.
- Wipe `memory.sqlite` (or recreate file) under the new schema.
- Backfill: `mode='if-empty'`, `window='7d'`, `scope='all'`. No file limit.
- After ingest, cycle1 (10 min interval) progressively classifies entries.
- cycle2 (1h interval) progressively promotes to `active`.
- Expected ramp-up: a few hours to a day.

### 8.1 First-day cost cap (nice-to-have, recommended)

Backfill of 7d may produce a burst of unclassified entries. To prevent
LLM cost spike on day 1:

- Optional `meta.cycle.day_one_llm_budget` (default 1000 calls)
- Optional throttle: cycle1 first day uses lower batch interval (e.g. 30m
  instead of 10m) until backlog drains.

This is recommended but not blocking the schema design.

## 9. Pre-requisite (must complete before schema cutover)

**Bench isolation** — `src/memory/bench/retrieval-eval.mjs` must redirect
its `DATA_DIR` to a sandboxed location (e.g. `os.tmpdir() + '/trib-plugin-bench-data'`)
and only fall back to production `CLAUDE_PLUGIN_DATA` behind an explicit
`--use-shared-data` flag.

Without this, any new schema gets re-contaminated by the next bench run.

## 10. Performance Expectations (conservative)

| Metric                | Estimate            |
|-----------------------|---------------------|
| DB size               | -10% to -30%       |
| Hybrid search latency | maintained to -25% |
| LLM classification    | -40% to -70% (with chunk grouping) |
| Core promotion        | UPDATE-in-place — small absolute win |
| Drift risk            | Eliminated         |

Final numbers must be measured against the prototype using the bench
harness (post-isolation).

## 11. Code Impact (transition surface)

In-scope modules:

- `src/memory/lib/memory.mjs`
- `src/memory/lib/memory-cycle.mjs`
- `src/memory/lib/memory-recall-store.mjs`
- `src/memory/lib/memory-retrievers.mjs`
- `src/memory/lib/memory-maintenance-store.mjs`
- `src/memory/index.mjs` (worker entry, MCP tool actions)
- `hooks/session-start.cjs` (recap + `session_id` use)
- `setup/setup-server.mjs`
- `scripts/skill-suggest.mjs`
- `src/shared/llm/semantic-cache.mjs` — to be deleted

Out-of-scope (no change required):
- `src/agent/*`, `src/channels/*` core (other than removed table dependencies)

## 12. Atomic Cutover Rule

The new schema must not run partially. Cutover order:

1. All listed modules updated and tested in isolation.
2. Bench isolation merged.
3. Schema swap (DROP + CREATE) executed in a single transaction.
4. Backfill triggered.
5. Verification (search returns, recap populated, cycle1/2 progresses).

If any step fails, the previous code path is restored and the new schema
is dropped.

## 13. Open Items (non-blocking)

- Future role extension (`system`) — schema already accepts it.
- Future source extension (voice/image) — `source_ref` prefix scheme is
  open-ended; `kind` column intentionally not reintroduced.
- `proactive_sources` re-introduction policy (Task #23 hold).
- Wide row monitoring once live.

## 14. Implementation Order

1. **Bench isolation** PR (`retrieval-eval.mjs` DATA_DIR isolation).
2. v3 design doc final approval (this document).
3. Schema implementation in `src/memory/lib/memory.mjs` (init function with parameterized vec dimension).
4. Refactor `memory-cycle.mjs` for `entries` model + chunk grouping prompt + root selection rule.
5. Refactor recall/retriever/maintenance modules with new query patterns.
6. Refactor `hooks/session-start.cjs` (recap + session_id) + `setup-server.mjs`.
7. Delete `semantic_cache.mjs` + `user_model` references.
8. Eval test (bench harness) — score formula, chunk grouping, cycle1/2 progression.
9. Wipe DB + bring up new schema + run backfill (window=7d).
10. Cross-check (reviewer ↔ tester rotation) until clean (no exceptions/mocks/fallbacks/dead code).
11. Final share with affected file list.
