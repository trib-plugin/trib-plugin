# MCP Instructions

## Orchestration (trib-agent)
- External model delegation: use MCP `bridge` tool. Session-based, parallel, scope maps to preset.
- Orchestrator tools: `bridge`, `create_session`, `list_sessions`, `close_session`, `list_models`.
- Native Claude agents: use the Agent tool with `trib-plugin:Worker`.

## Memory (trib-memory)
- CRITICAL: invoke the `search_memories` tool at session start and before any reference to prior context.
- Order: `search_memories` (past context) → `search` (external info) → codebase (Grep/Glob/Read). Never skip `search_memories` when past context may apply.
- When in doubt, call `search_memories` first — cost is near zero, missing context is expensive.

## Search (trib-search)
- CRITICAL: invoke the `search` MCP tool for external information lookups. Always use `trib-search` instead of built-in WebSearch/WebFetch.
- Scope: external/web info only. Not for codebase (Grep/Glob/Read) or past context (use `search_memories`).
- Order: recall → search → codebase. Use `batch` for 2+ operations.
