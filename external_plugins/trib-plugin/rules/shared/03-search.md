# Search

- All external information lookups MUST use `mcp__plugin_trib-plugin_trib-plugin__search` (MCP). Built-in `WebSearch` / `WebFetch` are forbidden.
- Accepts natural language. Include a URL to trigger scrape; mention `owner/repo` for GitHub code / issues / repos. An internal agent picks the provider and returns a synthesized answer.
- When unsure, search first. Never guess.
