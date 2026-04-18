## Search (trib-search)
- CRITICAL: invoke the `mcp__plugin_trib-plugin_trib-plugin__search` MCP tool for external information lookups. Always use `trib-search` instead of built-in WebSearch/WebFetch.
- Scope: external/web info only. Not for codebase (Grep/Glob/Read) or past context (use `mcp__plugin_trib-plugin_trib-plugin__recall`).
- Order: recall → search → codebase.
- Include URLs directly in the query to trigger scrape; mention `owner/repo` for GitHub code/issues. For multi-angle lookups pass an array to `query`.
