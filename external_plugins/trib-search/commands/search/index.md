---
description: "Quick web search via trib-search."
args: "<keywords>"
allowed-tools:
  - mcp__plugin_trib-search_trib-search__search
---

# /trib-search:search -- Quick Search

Run a web search using the trib-search MCP tool.

```
$ARGUMENTS
```

If arguments are provided, call:
```
search(keywords="$ARGUMENTS")
```

Present the search results naturally with titles, URLs, and snippets.

If no arguments are provided, ask the user what to search for.
