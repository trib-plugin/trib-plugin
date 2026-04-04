---
description: "Show trib-memory system status -- episodes, classifications, pending, cycle info."
args: ""
allowed-tools:
  - mcp__plugin_trib-memory_trib-memory__search_memories
---

# /trib-memory:status -- Memory Status

Call `search_memories(query="stats")` and display the result as a compact dashboard.

## Display

```
trib-memory status
------------------
Episodes:         1,234
Classifications:  89
Pending:          12
Last cycle:       2026-04-05 03:00
Cycle status:     idle
```

Present the stats returned by the tool. If the tool returns an error, report "trib-memory unavailable".
