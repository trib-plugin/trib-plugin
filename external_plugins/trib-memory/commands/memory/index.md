---
description: "Search or browse memories via trib-memory."
args: "<query | session | date | stats>"
allowed-tools:
  - mcp__plugin_trib-memory_trib-memory__search_memories
---

# /trib-memory:memory -- Memory Search & Browse

Route memory operations through the `search_memories` MCP tool.

```
$ARGUMENTS
```

## Routing

Parse `$ARGUMENTS` to determine the operation mode:

| Input | Action |
|-------|--------|
| (empty) or `stats` | `search_memories(query="stats")` |
| `last` or `session last` | `search_memories(session="last")` |
| `current` or `session current` | `search_memories(session="current")` |
| `YYYY-MM-DD` (date pattern) | `search_memories(date="<date>")` |
| `YYYY-MM-*` (date glob) | `search_memories(date="<pattern>")` |
| `rules` / `decisions` / `goals` / `preferences` / `incidents` / `directives` | `search_memories(query="<tag>")` |
| any other text | `search_memories(query="$ARGUMENTS")` |

## Output

Present results naturally. For search results, show relevant episodes with timestamps and content summaries. For stats, show episode counts, classification counts, pending items, and cycle status.
