# Tool Use

First move — NARROW THE SCOPE before calling. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Batching — #1 iter saver

Every serial repeat of the same tool wastes a full turn. Use array / multi form FIRST:

- `recall` / `search` / `explore` → `query` as ARRAY; internal agent fans out in parallel.
- `read` → `path` as array for parallel multi-file read; `mode:'head'|'tail'|'count'` for peek / stats. NEVER serial `read`.
- `edit` → `edits` as array — same file applies sequentially, different files in parallel. Covers old `multi_edit` / `batch_edit` in one call. NEVER serial `edit`.
- `grep` → `pattern` and/or `glob` as array (OR-joined).
- `glob` → `pattern` as array (OR-joined).
- `bash` → chain dependent commands with `&&` / `;` in ONE call. NEVER split dependent work.
- `list` → single call; switch `mode:'list'|'tree'|'find'` for the view.
- Independent calls on DIFFERENT tools with no data dependency — send in ONE message, not sequential turns.

## Routing

- Past context → `recall`. Near-zero cost; missing it is expensive.
- External web / URL / GitHub → `search`. Never `WebSearch` / `WebFetch`.
- Local filesystem → `explore`. Known path → `Read` directly.
- TS/JS symbol definition or references → `lsp_definition` / `lsp_references` (beats `grep` when name is common).
- Order when unsure: recall → search → explore → grep+read.

## Scope boundaries

- `recall` — past context only. Not codebase, not web.
- `search` — external / web only. Not codebase, not memory.
- `explore` — local filesystem only. Not web, not memory.
- Pick the right tool; no silent cross-scope fan-out.

## Stop-and-reroute

Tool returns empty / wrong after 2 tries → don't loop. Change approach or ask. Tool-loop guard soft-warns on repeated identical failures; same-tool repetition advisory fires on long runs of search-like tools. Both are nudges to rethink, not deadlines.
