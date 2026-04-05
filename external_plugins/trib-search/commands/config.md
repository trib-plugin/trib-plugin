---
description: Read or update trib-search config values directly without the setup menu.
args: "[path] [value]"
allowed-tools:
  - Read
  - Write
  - Edit
---

# trib-search Config

Manage `${CLAUDE_PLUGIN_DATA}/config.json` directly.

## Behavior

- If no args are provided:
  - read the config file
  - print a compact summary
- If only `path` is provided:
  - print the current value at that path
- If both `path` and `value` are provided:
  - update the config at that path
  - write the file back

## Supported paths

- `rawSearch.priority`
- `rawSearch.maxResults`
- `rawSearch.credentials.serper.apiKey`
- `rawSearch.credentials.brave.apiKey`
- `rawSearch.credentials.perplexity.apiKey`
- `rawSearch.credentials.firecrawl.apiKey`
- `rawSearch.credentials.tavily.apiKey`
- `rawSearch.credentials.xai.apiKey`
- `aiSearch.priority`
- `aiSearch.timeoutMs`
- `aiSearch.profiles.grok.apiKey`
- `aiSearch.profiles.grok.model`
- `aiSearch.profiles.grok.xSearchEnabled`
- `aiSearch.profiles.gemini.model`
- `aiSearch.profiles.claude.model`
- `aiSearch.profiles.claude.effort`
- `aiSearch.profiles.claude.fastMode`
- `aiSearch.profiles.codex.model`
- `aiSearch.profiles.codex.effort`
- `aiSearch.profiles.codex.fastMode`
- `crawl.maxPages`
- `crawl.maxDepth`
- `crawl.sameDomainOnly`
- `siteRules.x.com.search`
- `siteRules.x.com.scrape`

## Special rules

- If `path` is `rawSearch.priority` and the value is a single provider name, move that provider to index `0` and keep the rest in order.
- If a key path ends with `.apiKey`, never print the full secret back. Show only `set` or `empty`.
- If a path is missing, create the parent object as needed.
