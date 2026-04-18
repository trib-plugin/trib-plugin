# Search

- All external information lookups MUST use the `mcp__plugin_trib-plugin_trib-plugin__search` tool (MCP). Built-in WebSearch/WebFetch are forbidden. Accepts natural language; include a URL to trigger scrape, mention `owner/repo` for GitHub code/issues/repos. An internal agent picks the provider and returns a synthesized answer.
- **For 2+ lookups: pass them as an array in ONE call — `query: ["topic a", "topic b", "https://...", ...]`. Never issue multiple sequential `search` calls; the internal agent fans out in parallel inside a single invocation.**
- When unsure, search first. Never guess.
