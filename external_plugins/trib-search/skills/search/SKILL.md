---
name: search
user-invocable: false
description: >
  WHEN: User asks to research, look up, investigate, or search anything.
  Trending topics, new tools, libraries, products, news, comparisons.
  Facts that change — versions, APIs, pricing, docs, compatibility.
  Code for third-party libs. User says "search", "find", "look up",
  "check out", "what is X".
  When something is unfamiliar or not in training data — search first,
  never guess. Default: search. Skip only for timeless facts.
  WHEN NOT: Timeless facts — math, logic, well-established concepts.
  Pure opinion or Q&A with no factual lookup needed.
---

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

## Rules

- ALWAYS use trib-search tools instead of built-in WebSearch/WebFetch.
- Use `batch` for 2+ operations — never make separate calls.
- When something is unfamiliar or outside training data, search first. Never guess.
