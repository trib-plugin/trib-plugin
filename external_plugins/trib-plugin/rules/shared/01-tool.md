# Tool Use

First move — NARROW THE SCOPE before calling anything. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Batching — the #1 iter saver

Every serial repeat of the same tool wastes a full turn. Use array / multi form FIRST, not as fallback:

- `recall` / `search` / `explore` → `query` as an ARRAY in ONE call; the internal agent fans out in parallel.
- `read` → `path` as an array for parallel multi-file read; `mode:'head'|'tail'|'count'` for a peek or line/byte stats. NEVER serial `read`.
- `edit` → `edits` as an array — same file applies sequentially, different files run in parallel. Covers the old `multi_edit` (one file, N edits) and `batch_edit` (N files) cases in one call. NEVER serial `edit`.
- `grep` → `pattern` and/or `glob` as an array (OR-joined).
- `glob` → `pattern` as an array (OR-joined).
- `bash` → chain dependent commands with `&&` (stop on fail) or `;` (always run) in ONE call. NEVER split dependent work across turns.
- `list` → single call; switch `mode:'list'|'tree'|'find'` for the view you need.
- Independent calls on DIFFERENT tools with no data dependency — send in ONE message, not sequential turns.

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

## Stop-and-reroute

If a tool keeps returning empty / wrong results after 2 tries, don't loop. Change the approach or ask. The tool-loop guard soft-warns on repeated identical failures and a same-tool repetition advisory fires on long single-tool runs of search-like tools — treat both as nudges to rethink, not as deadlines to keep going until they fire.
