## Search (trib-search)
- CRITICAL: invoke the `search` MCP tool for external information lookups. Always use `trib-search` instead of built-in WebSearch/WebFetch.
- Scope: external/web info only. Not for codebase (Grep/Glob/Read) or past context (use `search_memories`).
- Order: recall → search → codebase. Use `batch` for 2+ operations.
