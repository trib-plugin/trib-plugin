# trib-search

Unified search plugin for Claude Code. Routes queries across 11 providers (7 raw + 4 AI) with intelligent fallback, caching, and cost tracking.

## MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Unified search — auto-routes by provider priority and search type |
| `firecrawl_scrape` | Fetch and extract readable content from URLs (batch supported) |
| `firecrawl_map` | Discover links from a page with optional filtering |
| `crawl` | BFS site traversal (max 200 pages, max depth 5) |
| `batch` | Parallel execution of search/scrape/map (max 10 items) |
| `setup` | Interactive configuration UI |

## Search Providers

### Raw Search (7 providers)

| Provider | Types | Site Search | Notes |
|----------|-------|-------------|-------|
| serper | web, news, images | Yes | Google Search, locale inference |
| brave | web | Yes | |
| perplexity | web | Yes | Academic mode available |
| firecrawl | web, news, images | Yes | Quota tracking |
| tavily | web, news | Yes | Search depth config |
| xai (Grok) | web, x-posts | Yes | X.com content via x_search |
| github | repos, code, issues | No | Search (3 types) + Read (file, repo, issue, pulls) |

### AI Search (4 providers)

| Provider | Connection | Model |
|----------|------------|-------|
| grok | API + CLI | grok-4.20-0309-reasoning |
| gemini | CLI | gemini-2.5-pro |
| claude | CLI | sonnet |
| codex | CLI | gpt-5.4 |

## Search Modes

| Mode | Behavior |
|------|----------|
| `search_first` (default) | Raw search → AI fallback |
| `ai_first` | AI search → Raw fallback |
| `ai_only` | AI only, no raw fallback |

## Web Scraping (3-tier fallback)

1. **readability** — DOM parsing via JSDOM + @mozilla/readability
2. **puppeteer** — Headless browser (auto-detects Chrome/Edge/Chromium)
3. **firecrawl** — API-based markdown extraction

## Routing

- Provider priority chain with automatic fallback on failure
- Per-domain site rules (force specific provider/scraper)
- GitHub auto-detection for code/repo/issue queries
- Provider cooldown (1 min) on failure

## Caching & Usage

- **Cache**: SHA256 key hashing, TTL per type (news 20m, web 30m, scrape 1h)
- **Usage**: Per-provider failure tracking, API quota snapshots (Firecrawl, Tavily), cost tracking (Grok/xAI)
- Both flush on process exit

## Configuration

Credentials resolved in order: `config.json` → environment variable.

```text
$CLAUDE_PLUGIN_DATA/config.json
├── rawSearch.credentials.*   (API keys per provider)
├── rawSearch.priority[]      (provider fallback order)
├── aiSearch.credentials.*    (AI provider keys)
├── aiSearch.priority[]       (AI fallback order)
├── siteRules{}               (per-domain overrides)
├── crawl{}                   (default limits)
└── requestTimeoutMs          (HTTP timeout, default 30s)
```

## Key Files

| File | Purpose |
|------|---------|
| `server.mjs` | MCP server, tool handlers, routing logic |
| `lib/providers.mjs` | Raw search provider implementations |
| `lib/ai-providers.mjs` | AI search provider implementations |
| `lib/web-tools.mjs` | Scrape, map, crawl implementations |
| `lib/cache.mjs` | TTL cache with deferred flush |
| `lib/state.mjs` | Provider state and usage tracking |

## What Is NOT Implemented

- **Commands**: No slash commands
- **Hooks**: Empty hooks.json
