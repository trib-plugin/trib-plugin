---
description: "Show trib-search provider state and connection summary."
args: ""
allowed-tools:
  - Read
---

# /trib-search:status -- Search Status

Read `${CLAUDE_PLUGIN_DATA}/usage.local.json` and `${CLAUDE_PLUGIN_DATA}/config.json`.

## Display

```
trib-search status
------------------
Raw Search Priority: serper > brave > perplexity > firecrawl > tavily > xai
AI Search Priority:  codex > claude > grok > gemini

Provider Status:
  serper        available    last: 2026-04-05 12:30
  brave         available    last: 2026-04-05 11:00
  xai           available    last: 2026-04-05 10:45
  ...

Site Rules:
  x.com         search: xai.x_search
                scrape: xai.x_search
```

Read config.json for priority arrays and site rules.
Read usage.local.json for provider availability and last-used timestamps.
If usage.local.json does not exist, report "no usage data recorded yet".
Keep the output compact.
