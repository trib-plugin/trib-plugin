# Tool Use

First move — NARROW THE SCOPE before calling anything. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Routing

- Past context → `recall` (memory store). Near-zero cost; missing it is expensive.
- External web / URL / GitHub → `search`. Never `WebSearch` / `WebFetch`.
- Local filesystem → `explore`. Known path → `Read` directly.
- TS / JS symbol definition or references → `lsp_definition` / `lsp_references` (beats `grep` when the name is common).
- Order when unsure: recall → search → explore → grep+read.

## Scope boundaries

- `recall` — past context only. Not codebase, not the web.
- `search` — external / web only. Not codebase, not memory.
- `explore` — local filesystem only. Not the web, not memory.
- Pick the right tool; no silent cross-scope fan-out.

## Batching — prioritize when the SAME tool is called 2+ times for related angles

- `recall` / `search` / `explore` → pass `query` as an ARRAY in ONE call; the internal agent fans out in parallel.
- `multi_read` → pass paths as an array. Never serial `read`.
- `multi_edit` (one file, N edits) / `batch_edit` (N files). Never serial `edit`.
- `grep` → pass `pattern` / `glob` as an array.
- Independent calls on DIFFERENT tools with no data dependency — send in ONE message, not sequential turns.

## Stop-and-reroute

If a tool keeps returning empty or wrong results, don't loop. Change the approach or ask.
