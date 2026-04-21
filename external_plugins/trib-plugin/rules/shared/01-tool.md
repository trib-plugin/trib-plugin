# Tool Use

First move — NARROW THE SCOPE before calling. A tool aimed at "the module responsible for X" finds it; a tool aimed at "X" returns noise.

## Batching — #1 iter saver

Every serial repeat of the same tool wastes a full turn. Use array / multi form FIRST:

- `recall` / `search` / `explore` → `query` as ARRAY; internal agent fans out in parallel.
- `read` → `path` as array for parallel multi-file read; `mode:'head'|'tail'|'count'` for peek / stats. NEVER serial `read`.
- `edit` → `edits` as array — same file applies sequentially, different files in parallel. Covers old `multi_edit` / `batch_edit` in one call. NEVER serial `edit`.
- `apply_patch` → prefer for non-trivial multi-file or large-context edits. One patch turn beats repeated `read` → `edit` loops.
- `grep` → `pattern` and/or `glob` as array (OR-joined).
- `glob` → `pattern` as array (OR-joined).
- `bash` → chain dependent commands with `&&` / `;` in ONE call. NEVER split dependent work.
- `list` → single call; switch `mode:'list'|'tree'|'find'` for the view.
- Independent calls on DIFFERENT tools with no data dependency — send in ONE message, not sequential turns.

## General Iter Budget

- Work in **2 rounds max per sub-problem**: round 1 = locate, round 2 = confirm. After that, synthesize or change approach.
- If `read` / `multi_read` / `grep` / `glob` / `list` is starting to repeat, stop and ask what NEW information the next call would add.
- If shell work spans multiple turns, prefer `bash_session` over replaying setup in repeated `bash` calls.
- If the change already exists as a unified diff in your head, use `apply_patch` instead of reconstructing it via repeated `read`/`edit`.
- If you already have enough evidence to act, stop probing and move to the edit / answer / summary.

## Routing

- Code change already clear in your head:
  Prefer `apply_patch` for multi-file or non-trivial edits before reaching for repeated `read` → `edit`.
- Shell work that likely needs more than one turn:
  Use `bash` normally in bridge sessions — it reuses the same underlying persistent shell state automatically. Do not waste turns re-running setup unless the environment actually changed.

- Past context → `recall`. Near-zero cost; missing it is expensive.
- External web / URL / GitHub → `search`. Never `WebSearch` / `WebFetch`.
- Local filesystem → `explore`. Known path → `Read` directly.
- Cross-file code structure → `code_graph`. Use it for imports, dependents, symbols, references, callers, and impact before falling back to raw `grep`.
- Order when unsure: recall → search → explore → grep+read.

## Scope boundaries

- `recall` — past context only. Not codebase, not web.
- `search` — external / web only. Not codebase, not memory.
- `explore` — local filesystem only. Not web, not memory.
- Pick the right tool; no silent cross-scope fan-out.

## Stop-and-reroute

Tool returns empty / wrong after 2 tries → don't loop. Change approach or ask. Tool-loop guard soft-warns on repeated identical failures; same-tool repetition advisory also watches long runs of high-iter tools like `read`, `grep`, `glob`, `bash`, and retrieval tools. Both are nudges to rethink, not deadlines.
