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
- Tool permissions are enforced at call time. If a tool returns a denied
  error, don't loop — report back.
