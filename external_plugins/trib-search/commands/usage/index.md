---
description: Show trib-search provider state, routing cache, and recent usage snapshot.
args: ""
allowed-tools:
  - Read
---

# trib-search Usage

Read `${CLAUDE_PLUGIN_DATA}/usage.local.json` and present a compact dashboard.

## Show

1. Provider status
   - provider name
   - `available`
   - `connection`
   - `source`
   - `lastSuccessAt`
   - `lastFailureAt`
   - `cooldownUntil`
   - quota fields when present
   - cost fields when present
2. `routingCache.rawBySite`
3. `routingCache.scrapeByHost`
4. `siteRules`

## Quota coverage

- `xai search`
  - current: `lastCostUsdTicks`, `updatedAt`, `lastUsedAt`, `lastSuccessAt`, `lastFailureAt`
  - future exact quota fields: possible if billing or team usage endpoints are connected
- `grok ai_search`
  - current: `lastCostUsdTicks`, `updatedAt`, `lastUsedAt`, `lastSuccessAt`, `lastFailureAt`
  - future exact quota fields: possible if billing or team usage endpoints are connected
- `firecrawl / tavily`
  - current: `available`, `source`, `updatedAt`, `lastUsedAt`, `lastSuccessAt`, `lastFailureAt`
  - exact quota fields: wired when the provider API key is configured
- `serper / brave / perplexity`
  - current: `available`, `source`, `updatedAt`, `lastUsedAt`, `lastSuccessAt`, `lastFailureAt`
  - future exact quota fields: provider-specific and only available when the upstream API exposes usage headers or a usage endpoint
- `claude / codex / gemini` via CLI
  - current: `available`, `source`, `updatedAt`, `lastUsedAt`, `lastSuccessAt`, `lastFailureAt`
  - exact quota percentage is not reliable from CLI-only execution, so do not present fake percentages

## Optional fields

- Show these fields only when they exist:
  - `remaining`
  - `limit`
  - `percentUsed`
  - `resetAt`
  - `lastCostUsdTicks`

## Output style

- Group by:
  - `Raw Search`
  - `AI Search`
  - `Scrape/Crawl`
- Keep it short and readable.
- If no file exists yet, say that no usage data has been recorded.
