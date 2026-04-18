## Memory schema

The plugin stores conversation memory in `memory.sqlite`, table `entries`:

| Field | Type | Meaning |
|---|---|---|
| `id` | int | Stable row id, never reused |
| `ts` | int (ms epoch) | Insertion timestamp |
| `role` | text | `user` / `assistant` / `system` / etc. |
| `content` | text | Raw message text |
| `is_root` | 0/1 | 1 = chunk root (synthesized), 0 = raw entry |
| `chunk_root` | int (nullable) | For non-root members, points to their root id |
| `element` | text | Subject label (5-10 words) — only on roots |
| `category` | enum | One of 8 categories — only on roots |
| `summary` | text | 3-sentence refined synthesis — only on roots |
| `score` | float | Recall ranking signal |
| `last_seen_at` | int | Last access timestamp |
| `status` | text | `active` / `archived` |
| `embedding` | blob | Vector for semantic search |

## The 8 categories (enum for `category` field)

- `rule` — system rules, identity facts, operating policies that are permanent. Phrased as "always X", "X uses Y format". Applies to every session, not a one-time choice.
- `constraint` — hard limits or forbidden operations (security, cost, time). Phrased as "never X", "do not Y". Violating is unacceptable.
- `decision` — explicit decisions the user has agreed to. One-shot choices with a clear resolution moment ("we picked X over Y"). Can change later; not a permanent rule.
- `fact` — verified facts, observed patterns, technical details. True right now — library behavior, system state, measured numbers, API shapes. Not opinions or plans.
- `goal` — long-term goals or direction. Open-ended targets ("reduce X by N%", "migrate to Y"). Not a concrete task.
- `preference` — user taste, style preferences. Subjective leanings ("prefer short replies", "like warm tone"). Softer than `fact`.
- `task` — current or pending work items. Concrete action items with a clear "done" state and known next step.
- `issue` — known problems, bugs, incidents. Broken state needing fixing, usually with a specific symptom.

When ambiguous, prefer the higher-grade category that fits:
`rule > constraint > decision > fact > goal > preference > task > issue`

## Disambiguation examples

- `rule` vs `constraint`: rule = "All commits use `YYYY-MM-DD HH:MM` prefix" (how we do things). constraint = "Never push to main without approval" (what we must not do).
- `task` vs `issue`: task = "Implement chunk grouping in cycle1" (planned work). issue = "vec_memory has 6,000 stale rows" (broken state).
- `decision` vs `fact`: decision = "We will use sqlite-vec for vector storage" (chosen path). fact = "sqlite-vec ships as a virtual table extension" (how it works).
- `fact` vs `preference`: fact = "User prefers Korean replies" (verified, hard expectation). preference = "User prefers warm tone" (taste, subjective).
- `goal` vs `decision`: goal = "Reduce LLM cost by 50% next quarter". decision = "Drop semantic_cache to simplify path".
- `rule` vs `preference`: rule = "All .md files must be written in English" (enforced policy). preference = "User dislikes unnecessary code comments" (style lean).
