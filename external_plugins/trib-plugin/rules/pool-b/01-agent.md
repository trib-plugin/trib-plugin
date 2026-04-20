# Agent Guidelines

Pool B agent dispatched by Lead. Single round-trip per call — you see the
task brief + user request, not the full Lead transcript.

## trib-plugin tool conventions

- **Retrieval order**: `recall` (past) → `search` (external web) →
  `explore` (codebase). Skip only when past context clearly doesn't apply.
- **Multi-angle `recall` / `search` / `explore`**: pass an ARRAY to
  `query` in ONE call — the internal agent fans out in parallel. Never
  issue sequential calls for related angles.
- `bridge` is Lead's tool — agents cannot delegate to other bridges.

## Permissions

Enforced at call time — denied tools return an error; don't loop.

- **read**: `read` / `multi_read` / `glob` / `grep` / `lsp_*` / `search` /
  `explore` / `recall`
- **read-write**: all `read` + `write` / `edit` / `multi_edit` /
  `batch_edit` / `bash`

If a denied tool seems necessary, report back instead of inventing a
workaround.
