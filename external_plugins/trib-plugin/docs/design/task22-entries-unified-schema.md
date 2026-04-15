# Task #22 — Unified `entries` Schema Redesign

**Status**: Draft for review
**Owner**: lead
**Reviewers**: GPT (bridge), Opus worker (native)
**Date**: 2026-04-15

---

## 1. Background

Current `memory.sqlite` schema is fragmented across 17+ tables with significant
overlap, drift risk, and dual storage. Key problems observed:

- 17+ tables (`episodes`, `classifications`, `memory_chunks`, `core_memory`,
  `memory_vectors`, `vec_memory`, plus FTS shadow tables, plus dormant tables).
- Multi-user / multi-channel residue columns (`backend`, `channel_id`,
  `user_id`, `user_name`) inflate rows in a personal single-user DB.
- Duplicated metadata across `classifications` / `memory_chunks` / `core_memory`
  (topic, importance, ts, day_key etc).
- Dual vector storage: `memory_vectors` (canonical JSON) + `vec_memory`
  (sqlite-vec virtual). `deduplicateClassifications()` deletes from
  `memory_vectors` only — leaves stale residue in `vec_memory` (~6,000 orphan
  rows in the live DB).
- Bench data leakage: `retrieval-eval.mjs` writes to production DB via
  `CLAUDE_PLUGIN_DATA` fallback (25 `__bench__` rows with ts=2099 contaminated
  Session Recap).
- Dead/legacy tables: `user_model` (228 legacy rows), `semantic_cache`
  (8 rows, hit_count 0), `classification_stats` (0 rows dormant),
  `documents` (0), `pending_embeds` (0).

## 2. Goals

1. **Unify** all memory entities into a single `entries` table with
   self-referential chunk grouping.
2. **Eliminate redundancy** in metadata storage and dual vector stores.
3. **Preserve raw originals** to enable re-grouping and audit.
4. **Define quantitative score** with decoupled priority and decay control.
5. **Reduce table count** from 17+ to ~4 (entries / vec_entries /
   entries_fts / meta) plus optional `proactive_sources`.
6. **Improve runtime performance**: fewer joins, BLOB vectors, simpler
   rowid mapping, cheaper LLM classification via chunk grouping.

## 3. Final Schema

### 3.1 `entries` (single unified table)

| Column            | Type    | NN | Default | Purpose                                                                                       |
|-------------------|---------|----|---------|-----------------------------------------------------------------------------------------------|
| `id`              | INTEGER | -  | PK      | Identifier                                                                                    |
| `ts`              | INTEGER | ✓  | -       | Unix milliseconds                                                                             |
| `role`            | TEXT    | ✓  | -       | `user` / `assistant`                                                                          |
| `content`         | TEXT    | ✓  | -       | Raw original content (always preserved, never destroyed)                                      |
| `chunk_root`     | INTEGER | -  | NULL    | Self-FK. NULL = unclassified. `=id` = chunk root. Other id = member of that chunk root        |
| `element`         | TEXT    | -  | NULL    | Short subject/label (5–10 words). Chunk root only                                             |
| `category`        | TEXT    | -  | NULL    | One of: `rule`, `identity`, `constraint`, `policy`, `decision`, `fact`, `goal`, `preference`, `observation`, `task`, `issue`. Chunk root only |
| `summary`         | TEXT    | -  | NULL    | Refined synthesis of chunk member entries (1–3 paragraphs). Chunk root only                   |
| `status`          | TEXT    | -  | NULL    | `classified` / `core_pending` / `core_active` / `core_demoted` / `archived`. Chunk root only  |
| `score`           | REAL    | -  | NULL    | Computed score (cache). See section 5                                                         |
| `mention_count`   | INTEGER | -  | 0       | Cumulative reference count                                                                    |
| `promoted_at`     | INTEGER | -  | NULL    | Core promotion timestamp (immutable, statistical)                                             |
| `last_seen_at`    | INTEGER | -  | NULL    | Last activation time (decay base). Updated on mention/retrieval hit                           |
| `embedding`       | BLOB    | -  | NULL    | float32 vector (canonical). Chunk root only                                                   |
| `content_hash`    | TEXT    | -  | NULL    | SHA-256 over summary text. Detects re-embedding need                                           |

**Constraints**

- `UNIQUE (ts, role)` — backfill dedupe (no source_ref needed; transcript
  lines have ms-precision timestamps)
- `INDEX (chunk_root)` — group lookups
- `INDEX (status)` — core_active / archived filters
- `INDEX (ts DESC)` — recap and recent queries

### 3.2 `vec_entries` (sqlite-vec virtual, derived index)

```sql
CREATE VIRTUAL TABLE vec_entries USING vec0(embedding float[1024])
```

- `rowid = entries.id` directly (no type-prefix encoding)
- KNN acceleration only. `entries.embedding` is canonical
- DROP/REBUILD safe at any time

### 3.3 `entries_fts` (sqlite-fts5, auto-synced)

```sql
CREATE VIRTUAL TABLE entries_fts USING fts5(
  content, element, summary,
  content='entries', content_rowid='id'
)
```

- BM25 sparse search
- Maintained via INSERT/UPDATE/DELETE triggers on `entries`

### 3.4 `meta` (operational KV)

| Column  | Type | NN | Notes |
|---------|------|----|-------|
| `key`   | TEXT | -  | PK    |
| `value` | TEXT | ✓  | JSON or scalar |

Convention: dotted prefixes (`embedding.current_model`,
`state.transcript_offsets`, `boot.schema_bootstrap_complete`,
`cycle.last_run_at`).

### 3.5 `proactive_sources` (preserved as-is, separate review later)

Existing schema retained pending Task #23.

## 4. Removed / Consolidated

| Old table                                  | Disposition                                              |
|--------------------------------------------|----------------------------------------------------------|
| `episodes`                                 | Merged into `entries`                                    |
| `classifications`                          | Absorbed into `entries` (element/category/summary cols)  |
| `memory_chunks`                            | Absorbed into `entries.chunk_root` self-FK               |
| `core_memory`                              | Absorbed into `entries.status='core_*'` + score family   |
| `memory_vectors`                           | Absorbed into `entries.embedding` + `content_hash`       |
| `vec_memory`                               | Replaced by `vec_entries` (rowid = entries.id direct)    |
| `classifications_fts`, `memory_chunks_fts` | Unified into `entries_fts`                               |
| `memory_meta`                              | Renamed to `meta`                                         |
| `user_model` (228 legacy)                  | Code + usages fully removed                              |
| `semantic_cache` (16)                      | Code + usages fully removed                              |
| `classification_stats` (0 dormant)         | Dropped                                                  |
| `documents` (0 dormant)                    | Dropped                                                  |
| `pending_embeds` (0 dormant)               | Dropped (in-memory queue if needed)                      |

Removed columns (multi-user / channel residue): `backend`, `channel_id`,
`user_id`, `user_name`, `session_id`, `day_key`, `created_at`, `kind`,
`classified`, `source_ref`, `embedding_model`, `dims`, `confidence`, `topic`.

## 5. Quantitative Score Model

`score` is **derived** from category metadata and runtime signals. LLM
self-confidence is NOT used.

```
ageDays      = (now - last_seen_at) / 86_400_000
adjusted_age = ageDays * (1 - decay_factor[category])
decay        = 1 / (1 + adjusted_age / 30) ^ 0.3
mention_boost = 1 + log(1 + mention_count) * 0.2
score        = priority[category] * decay * mention_boost
```

**Properties**

- Mention or retrieval hit → set `last_seen_at = now` → `decay = 1.0` (reset)
- `decay_factor = 1.0` → `adjusted_age = 0` always → permanent (no decay)
- `decay_factor = 0.0` → standard decay applies
- `priority` scales the absolute score ceiling
- Cached on `entries.score` for ranking; recomputed by cycles

### Category metadata (code-side `CATEGORY_META` constant)

| category     | priority | decay_factor | Notes                               |
|--------------|----------|--------------|-------------------------------------|
| `rule`       | 1.0      | 1.0          | Permanent system rules              |
| `identity`   | 1.0      | 1.0          | User/bot persona, names             |
| `constraint` | 0.95     | 0.9          | Security/limit, near-permanent      |
| `policy`     | 0.9      | 0.85         | Meta operating policies             |
| `decision`   | 0.9      | 0.7          | Agreed decisions                    |
| `fact`       | 0.8      | 0.5          | Verified facts                      |
| `goal`       | 0.75     | 0.4          | Long-term goals (revisable)         |
| `preference` | 0.7      | 0.4          | User preferences (revisable)        |
| `observation`| 0.55     | 0.2          | Patterns, insights (decays fast)    |
| `task`       | 0.5      | 0.05         | Active work (vanishes when done)    |
| `issue`      | 0.4      | 0.05         | Known issues (vanishes when fixed)  |

## 6. Runtime Operations

| Operation                | Behaviour                                                                                                |
|--------------------------|----------------------------------------------------------------------------------------------------------|
| Transcript ingest        | INSERT into `entries` (kind=message only; other kinds NOT injected at all)                               |
| cycle1 classification    | SELECT unclassified (chunk_root IS NULL) → LLM groups + emits element/category/summary → root UPDATE; member UPDATE chunk_root=root |
| Embedding                | Embed `summary` (chunk root only). Members not embedded. Hash skip if content_hash matches               |
| cycle2 core promotion    | Re-evaluate classified entries → status='core_active' UPDATE + promoted_at + score baseline              |
| Core demotion            | Status flip to 'core_demoted'                                                                            |
| Search (hybrid)          | vec_entries KNN → rowid==entries.id → entries direct join → optional chunk_root grouping                 |
| Vector index rebuild     | DROP vec_entries, recreate, INSERT all entries with non-null embedding                                   |

## 7. Migration Strategy (high-level)

1. Create new schema in a side database file or fresh tables.
2. Copy data:
   - episodes → entries (drop removed columns)
   - For each classification: locate root episode, set `entries.chunk_root = root.id`,
     copy topic/element/importance into element/category/summary, set status='classified'.
   - For each `memory_chunks` row: ensure mapping coherence; member entries
     get `chunk_root = root.id`.
   - For each `core_memory` row: set status='core_active' on the corresponding
     chunk root; copy score / mention_count / promoted_at / last_seen_at.
   - For each `memory_vectors` row: copy vector_json → BLOB into
     `entries.embedding` (only chunk roots) + `content_hash`.
3. Rebuild `vec_entries` from `entries.embedding`.
4. Backfill FTS via `INSERT INTO entries_fts(rowid, content, element, summary)`.
5. Verify counts and spot-check sample rows.
6. Switch path resolver / readers to new schema.
7. Drop old tables.

## 8. Performance Expectations

- DB size: ~340 MB → ~200 MB (-40%) from BLOB vectors and removed metadata duplication.
- Hybrid search latency: -30% to -60% (fewer joins, no rowid type-prefix
  decode, direct entries.id mapping).
- JS cosine fallback: -20% to -40% (BLOB float32 vs JSON parse).
- LLM classification cost: -50% to -80% if chunk grouping reduces calls
  per N member entries.
- Core promotion: -50%+ (UPDATE in place vs INSERT a new row).

## 9. Risks & Open Items

- Wide row (16 columns) with many NULL on member entries. SQLite NULL
  bitmap handles this, but row size still increases page footprint.
- Self-referential `chunk_root` semantics: a single row can be both a
  member-shaped entry (when it's a chunk member) and a root-shaped entry
  (when chunk_root = id). Documentation must be explicit.
- Migration is large and impacts many code paths
  (`memory.mjs`, `memory-cycle.mjs`, `memory-recall-store.mjs`,
  `memory-retrievers.mjs`, `memory-maintenance-store.mjs`,
  `hooks/session-start.cjs`).
- `proactive_sources` deferred — interaction with the unified schema
  must be revisited in Task #23.
- Drop of `semantic_cache` removes LLM cost-saving cache. Acceptable for
  the personal-use scale, but quantify the loss.
- Bench isolation (`retrieval-eval.mjs`) must land before any rebuild,
  otherwise the new DB can be re-contaminated.

## 10. Review Questions

Reviewers please address each item explicitly:

1. **Coverage** — Is every meaningful piece of state in the current
   schema (and code) representable in the proposed `entries` model?
   List anything that does not fit.
2. **Self-FK semantics** — Are there read or write paths in the existing
   code that would be awkward or unsafe with the chunk_root self-FK
   pattern? Suggest alternative if so.
3. **Score formula** — Is the priority × decay × mention_boost formula
   stable for the live workload? Any pathological inputs?
4. **Category set** — Are 11 categories the right granularity? Are any
   categories overlapping (e.g. policy vs rule, observation vs fact)?
5. **Migration safety** — Identify migration pitfalls (data loss,
   incomplete copy, FK violations, FTS sync gaps).
6. **Vector consolidation** — Is the single canonical `entries.embedding`
   + derived `vec_entries` model sufficient, or are there cases where
   the dual store served a real purpose?
7. **FTS schema** — Should FTS index more columns or fewer? Tokenizer
   choice impact for Korean content?
8. **Index list** — Are the proposed indexes (chunk_root, status,
   ts DESC, UNIQUE(ts, role)) sufficient? Any missing for hot paths?
9. **Performance estimates** — Validate or refute the -40% disk and
   -30/60% search latency estimates. Provide a counter-estimate if
   different.
10. **Backward compatibility** — Does anything outside `src/memory/`
    (channels, agent, hooks, setup UI) depend on the old schema in a way
    that requires schema-bridging code during transition?

Return findings as concise bullet points. Highlight blockers separately
from nice-to-haves.
