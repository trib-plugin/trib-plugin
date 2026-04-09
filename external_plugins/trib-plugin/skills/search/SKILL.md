---
name: search
user-invocable: false
description: >
  WHEN: User asks to research, look up, or investigate external information.
  Trending topics, new tools, libraries, products, news, comparisons.
  Facts that change — versions, APIs, pricing, docs, compatibility.
  Code for third-party libs. User says "search", "find", "look up".
  When something is unfamiliar or outside training data — search first, never guess.
  WHEN NOT: Timeless facts — math, logic, well-established concepts.
  Codebase-internal exploration (use Grep/Glob/Read).
  Past work/context recall (use trib-memory recall).
  Scope: external web information only.
  Order: recall → search → codebase.
---

## Non-negotiable

- ALWAYS use trib-search tools instead of built-in WebSearch/WebFetch.
- Scope: external/web information only. Not for codebase exploration or past context recall.
- Order: recall (past context) → search (external info) → codebase (Grep/Glob/Read). Never skip recall when past context may apply.
- Use `batch` for 2+ operations — never make separate calls.
- When something is unfamiliar or outside training data, search first. Never guess.

## Tool Call Patterns

### Single search
```
mcp__trib-search__search({ query: "search terms" })
```

### Multiple lookups (2+ queries)
```
mcp__trib-search__batch({
  items: [
    { action: "search", query: "first query" },
    { action: "search", query: "second query" }
  ]
})
```

### Scrape a specific URL
```
mcp__trib-search__firecrawl_scrape({ url: "https://..." })
```

### Discover links from a page
```
mcp__trib-search__firecrawl_map({ url: "https://..." })
```

### Crawl a site
```
mcp__trib-search__crawl({ url: "https://...", maxPages: 10 })
```
