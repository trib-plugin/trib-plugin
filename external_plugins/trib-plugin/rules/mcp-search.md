## Search (trib-search)
- CRITICAL: invoke the `mcp__plugin_trib-plugin_trib-plugin__search` MCP tool for external information lookups. Always use `trib-search` instead of built-in WebSearch/WebFetch.
- Scope: external/web info only. Not for codebase (Grep/Glob/Read) or past context (use `mcp__plugin_trib-plugin_trib-plugin__search_memories`).
- Order: recall → search → codebase. Use `mcp__plugin_trib-plugin_trib-plugin__batch` for 2+ operations.
