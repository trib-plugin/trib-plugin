# trib-search Configuration Reference

All settings live in `config.json` inside the plugin data directory (`$CLAUDE_PLUGIN_DATA/config.json`).
On first run, a default config is auto-created at this path.

---

## File Locations

| File | Path | Description |
|------|------|-------------|
| `config.json` | `$CLAUDE_PLUGIN_DATA/config.json` | Main configuration |
| `usage.local.json` | `$CLAUDE_PLUGIN_DATA/usage.local.json` | Provider usage tracking |
| `cache.local.json` | `$CLAUDE_PLUGIN_DATA/cache.local.json` | Response cache |
| `settings.default.md` | `$CLAUDE_PLUGIN_ROOT/settings.default.md` | Default MCP instructions (read-only) |
| `settings.local.md` | `$CLAUDE_PLUGIN_DATA/settings.local.md` | Custom MCP instructions (user-created) |

`settings.default.md` contains the built-in rules injected into the MCP server instructions. `settings.local.md` is optional — if present, its content is appended after the defaults. Use it to add custom rules without modifying the shipped file.

---

## Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `rawSearch` | object | — | Raw search provider configuration |
| `aiSearch` | object | — | AI search provider configuration |
| `requestTimeoutMs` | number | `30000` | HTTP request timeout for raw search providers (ms) |
| `crawl` | object | — | Crawl tool defaults |
| `siteRules` | object | — | Per-domain routing overrides |

---

## `rawSearch`

Controls raw (non-AI) search providers. This priority applies only to the raw search function group. Providers are tried in priority order; the first success is returned immediately (fallback mode).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `priority` | string[] | `["serper", "brave", "perplexity", "firecrawl", "tavily", "xai"]` | Provider try order. First available + successful wins. |
| `maxResults` | number | `10` | Default max results per search (overridable per call, max 20) |
| `credentials` | object | — | Per-provider API key configuration |

### `rawSearch.credentials`

Each provider has a `credentials.<provider>.apiKey` field. API keys can also be set via environment variables — the bootstrapper (`run-mcp.mjs`) reads keys from `config.json` and injects them as env vars at startup.

| Provider | Config Path | Env Variable(s) | Notes |
|----------|-------------|-----------------|-------|
| `serper` | `rawSearch.credentials.serper.apiKey` | `SERPER_API_KEY` | Google Search via Serper |
| `brave` | `rawSearch.credentials.brave.apiKey` | `BRAVE_API_KEY` | Brave Search API |
| `perplexity` | `rawSearch.credentials.perplexity.apiKey` | `PERPLEXITY_API_KEY` | Perplexity Search API |
| `firecrawl` | `rawSearch.credentials.firecrawl.apiKey` | `FIRECRAWL_API_KEY` | Firecrawl search + scrape |
| `tavily` | `rawSearch.credentials.tavily.apiKey` | `TAVILY_API_KEY` | Tavily Search API |
| `xai` | `rawSearch.credentials.xai.apiKey` | `XAI_API_KEY`, `GROK_API_KEY` | xAI / Grok (also used for x_search) |
| `github` | `rawSearch.credentials.github.token` | `GITHUB_TOKEN` | GitHub Search API (code search requires auth) |

**Credential resolution order**: config.json credential field (`apiKey`, or `token` for github) > environment variable. If both exist, config takes precedence.

**Note**: `github` is not included in the default `priority` array. It is only used when explicitly routed via `site:github.com` or siteRules.

### Raw Provider Capabilities

| Provider | Search Types | Site Search | X Content |
|----------|-------------|-------------|-----------|
| `serper` | web, news, images | Yes | No |
| `brave` | web | Yes | No |
| `perplexity` | web | Yes | No |
| `firecrawl` | web, news, images | Yes | No |
| `tavily` | web, news | Yes | No |
| `xai` | web, x-posts | Yes | Yes |
| `github` | repositories, code, issues | No | No |

---

## `aiSearch`

Controls AI-powered answer search. This priority applies only to the AI answer-search function group. Providers are tried in priority order until one succeeds (fallback chain).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `priority` | string[] | `["codex", "claude", "grok", "gemini"]` | Provider try order |
| `timeoutMs` | number | `120000` | Default timeout for AI search calls (ms, overridable per call, max 300000) |
| `profiles` | object | — | Per-provider connection and model settings |

### `aiSearch.profiles`

Each AI provider has a profile that controls how it connects and which model to use.

#### `profiles.grok`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connection` | string | `"api"` | `"api"` (direct API) or `"cli"` (grok CLI binary) |
| `apiKey` | string | `""` | xAI API key (also used by raw xai provider) |
| `model` | string | `"grok-4.20-0309-reasoning"` | Model identifier |
| `xSearchEnabled` | boolean | `true` | Use x_search tool for x.com queries (API mode only) |

#### `profiles.gemini`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connection` | string | `"cli"` | Only `"cli"` supported (requires `gemini` binary) |
| `model` | string | `"gemini-2.5-pro"` | Model identifier |

#### `profiles.claude`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connection` | string | `"cli"` | Only `"cli"` supported (requires `claude` binary) |
| `model` | string | `"sonnet"` | Model identifier |
| `effort` | string | `"medium"` | Reasoning effort level |
| `fastMode` | boolean | `false` | Use fast service tier |

#### `profiles.codex`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `connection` | string | `"cli"` | Only `"cli"` supported (requires `codex` binary) |
| `model` | string | `"gpt-5.4"` | Model identifier |
| `effort` | string | `"xhigh"` | Reasoning effort level |
| `fastMode` | boolean | `true` | Use fast service tier |

### AI Provider Availability

- **API mode** (`grok`): Available when API key is configured
- **CLI mode** (`claude`, `codex`, `gemini`): Available when the binary exists in PATH

---

## `crawl`

Default settings for the `crawl` tool.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxPages` | number | `10` | Maximum pages to crawl (per call max 200) |
| `maxDepth` | number | `1` | Maximum link depth (per call max 5) |
| `sameDomainOnly` | boolean | `true` | Restrict crawl to same domain |

---

## `siteRules`

Per-domain routing overrides. When a request targets a matching domain, the specified provider and method are used instead of the normal priority chain. Cross-fallback is skipped for siteRule-routed requests.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `<domain>` | object | — | Domain-specific routing |
| `<domain>.search` | string | — | Raw search routing (format: `provider.method`) |
| `<domain>.scrape` | string | — | Scrape routing (format: `provider.method`) |

### Default siteRules

```json
{
  "x.com": {
    "search": "xai.x_search",
    "scrape": "xai.x_search"
  }
}
```

`x.com` is not a reliable scrape target, so both search and scrape are routed through xAI's `x_search` tool.

---

## Cache TTL

The cache is stored in `cache.local.json`. Entries are automatically pruned on load. TTL values are hardcoded:

| Request Type | TTL | Description |
|-------------|-----|-------------|
| `search(web)` | 30 min | Web search results |
| `search(news)` | 20 min | News search results |
| `search(images)` | 60 min | Image search results |
| `ai_search` | 20 min | AI search answers |
| `x_search` / `x.com` routes | 10 min | X/Twitter content |
| `scrape` | 60 min | Scraped page content |

Cache is flushed to disk with a 5-second debounce delay, and force-flushed on process exit/signal.

---

## Cross-Fallback Behavior

- If all raw search providers fail, the system automatically falls back to AI search providers in priority order.
- If all AI search providers fail, the system falls back to raw search providers in priority order.
- Cross-fallback is **skipped** when a siteRule explicitly routes the request.

---

## Legacy Config Migration

Old flat-key config formats are automatically normalized to the current structure on load:

| Legacy Key | New Path |
|-----------|----------|
| `serperApiKey` | `rawSearch.credentials.serper.apiKey` |
| `braveApiKey` | `rawSearch.credentials.brave.apiKey` |
| `perplexityApiKey` | `rawSearch.credentials.perplexity.apiKey` |
| `firecrawlApiKey` | `rawSearch.credentials.firecrawl.apiKey` |
| `tavilyApiKey` | `rawSearch.credentials.tavily.apiKey` |
| `xaiApiKey` / `grokApiKey` | `rawSearch.credentials.xai.apiKey` |
| `rawProviders` | `rawSearch.priority` |
| `rawMaxResults` | `rawSearch.maxResults` |
| `aiDefaultProvider` | `aiSearch.priority[0]` |
| `aiPriority` | `aiSearch.priority` |
| `aiTimeoutMs` | `aiSearch.timeoutMs` |
| `aiModels.<provider>` | `aiSearch.profiles.<provider>.model` |

---

## Example Configuration

### Minimal (API keys only)

```json
{
  "rawSearch": {
    "credentials": {
      "serper": { "apiKey": "YOUR_SERPER_KEY" },
      "xai": { "apiKey": "YOUR_XAI_KEY" }
    }
  }
}
```

### Full

```json
{
  "rawSearch": {
    "priority": ["serper", "brave", "perplexity", "firecrawl", "tavily", "xai"],
    "maxResults": 10,
    "credentials": {
      "serper": { "apiKey": "YOUR_SERPER_KEY" },
      "brave": { "apiKey": "YOUR_BRAVE_KEY" },
      "perplexity": { "apiKey": "YOUR_PERPLEXITY_KEY" },
      "firecrawl": { "apiKey": "YOUR_FIRECRAWL_KEY" },
      "tavily": { "apiKey": "YOUR_TAVILY_KEY" },
      "xai": { "apiKey": "YOUR_XAI_KEY" },
      "github": { "token": "YOUR_GITHUB_TOKEN" }
    }
  },
  "aiSearch": {
    "priority": ["codex", "claude", "grok", "gemini"],
    "timeoutMs": 120000,
    "profiles": {
      "grok": {
        "connection": "api",
        "apiKey": "YOUR_XAI_KEY",
        "model": "grok-4.20-0309-reasoning",
        "xSearchEnabled": true
      },
      "firecrawl": {
        "connection": "api",
        "apiKey": "YOUR_FIRECRAWL_KEY"
      },
      "gemini": {
        "connection": "cli",
        "model": "gemini-2.5-pro"
      },
      "claude": {
        "connection": "cli",
        "model": "sonnet",
        "effort": "medium",
        "fastMode": false
      },
      "codex": {
        "connection": "cli",
        "model": "gpt-5.4",
        "effort": "xhigh",
        "fastMode": true
      }
    }
  },
  "requestTimeoutMs": 30000,
  "crawl": {
    "maxPages": 10,
    "maxDepth": 1,
    "sameDomainOnly": true
  },
  "siteRules": {
    "x.com": {
      "search": "xai.x_search",
      "scrape": "xai.x_search"
    }
  }
}
```

---

## Environment Variables

The bootstrapper (`scripts/run-mcp.mjs`) reads API keys from `config.json` and injects them as environment variables before starting the server. You can also set them directly in your shell environment.

| Variable | Provider | Notes |
|----------|----------|-------|
| `SERPER_API_KEY` | serper | |
| `BRAVE_API_KEY` | brave | |
| `PERPLEXITY_API_KEY` | perplexity | |
| `FIRECRAWL_API_KEY` | firecrawl | Used by the raw firecrawl provider and firecrawl scrape extractor |
| `TAVILY_API_KEY` | tavily | |
| `XAI_API_KEY` | xai / grok | Also sets `GROK_API_KEY` |
| `GROK_API_KEY` | xai / grok | Fallback for `XAI_API_KEY` |
| `GITHUB_TOKEN` | github | Required for code search, optional for repos/issues |
| `CLAUDE_PLUGIN_ROOT` | system | Plugin installation root (auto-set) |
| `CLAUDE_PLUGIN_DATA` | system | Plugin data directory (auto-set) |

---

## MCP Tools

The following tools are exposed by the server:

| Tool | Description |
|------|-------------|
| `search` | Raw search with auto provider selection |
| `ai_search` | AI-powered answer search with fallback chain |
| `scrape` | Extract content from known URLs |
| `map` | Discover links on a page |
| `crawl` | Multi-page content collection |
| `batch` | Parallel execution of search, ai_search, scrape, map actions (max 10 items) |
