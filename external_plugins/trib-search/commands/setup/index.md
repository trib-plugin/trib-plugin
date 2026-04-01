---
description: Open the trib-search setup menu and update search, AI, key, crawl, or usage settings.
args: ""
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Edit
---

# trib-search Setup

Use this command as an interactive setup menu for `${CLAUDE_PLUGIN_DATA}/config.json`.

If the config file does not exist, create it with this base shape first:

```json
{
  "rawSearch": {
    "priority": ["serper", "brave", "perplexity", "firecrawl", "tavily", "xai"],
    "maxResults": 5,
    "credentials": {
      "serper": { "apiKey": "" },
      "brave": { "apiKey": "" },
      "perplexity": { "apiKey": "" },
      "firecrawl": { "apiKey": "" },
      "tavily": { "apiKey": "" },
      "xai": { "apiKey": "" }
    }
  },
  "aiSearch": {
    "priority": ["codex", "claude", "grok", "gemini"],
    "timeoutMs": 120000,
    "profiles": {
      "grok": {
        "connection": "api",
        "apiKey": "",
        "model": "grok-4.20-0309-reasoning",
        "xSearchEnabled": true
      },
      "firecrawl": {
        "connection": "api",
        "apiKey": ""
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

## Menu flow

1. Read the current config and show a compact summary first.
2. Ask which section to open:
   - `Raw Search`
   - `AI Search`
   - `API Keys`
   - `Crawl`
   - `Usage`
3. Perform only the selected section update.
4. Write only the changed fields back to `${CLAUDE_PLUGIN_DATA}/config.json`.

## Section behavior

### Raw Search

- Show the current `rawProviders` order.
- Show the current `rawSearch.priority` order.
- Ask which provider should move to the top priority.
- Valid providers:
  - `serper`
  - `brave`
  - `perplexity`
  - `firecrawl`
  - `tavily`
  - `xai`
- If the user selects one, reorder the array so that provider becomes index `0` and preserve the rest in their current order.
- Ask for optional `rawSearch.maxResults` update.

### AI Search

- Show:
  - current `aiSearch.priority`
  - current `aiSearch.profiles`
- Ask which AI provider should move to the top priority:
  - `grok`
  - `gemini`
  - `claude`
  - `codex`
- If the user selects one, reorder `aiSearch.priority` so that provider becomes index `0` and preserve the rest in their current order.
- Ask whether the user wants to update a model value.
- If yes, ask which provider model to change and write the new model string to `aiSearch.profiles.<provider>.model`.
- If the provider is `claude` or `codex`, allow optional `effort` and `fastMode` updates.
- Ask for optional `aiSearch.timeoutMs` update.

### API Keys

- Show whether these values are set or empty:
  - `rawSearch.credentials.serper.apiKey`
  - `rawSearch.credentials.brave.apiKey`
  - `rawSearch.credentials.perplexity.apiKey`
  - `rawSearch.credentials.firecrawl.apiKey`
  - `rawSearch.credentials.tavily.apiKey`
  - `rawSearch.credentials.xai.apiKey`
  - `aiSearch.profiles.grok.apiKey`
- Ask which key to edit.
- Let the user:
  - set a new value
  - clear the value
- Never echo the full key back in the summary. Show only `set` or `empty`.

### Crawl

- Show current:
  - `crawl.maxPages`
  - `crawl.maxDepth`
  - `crawl.sameDomainOnly`
- Ask which field to update and write only that field.

### Usage

- Read `${CLAUDE_PLUGIN_DATA}/usage.local.json`.
- Show active providers, connection type, source, last success/failure, and routing cache summary.
- Explicitly include `siteRules.x.com`.
- Do not write config in this section.

## Output style

- Keep the summary short and menu-like.
- Present the updated values after each change.
- Do not expose secret key contents.
