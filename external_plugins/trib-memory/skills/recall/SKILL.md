---
name: recall
user-invocable: false
description: >
  **BLOCKING REQUIREMENT**: When you need to recall, search, or store memories,
  you MUST use the trib-memory MCP tools (search_memories, memory_cycle) exclusively.
  Do NOT use file-based memory (MEMORY.md, memory/ directory) or any built-in auto-memory system.
  Triggers on: "remember this", "what did we do before", "check previous work",
  resuming prior sessions, or any context that requires recalling past conversations.
---

## search_memories — single tool, auto-routed by params

**Search** (hybrid keyword + embedding):
  search_memories(query="keyword")
  search_memories(query="keyword", sort="date")
  search_memories(query="keyword", date="2026-04-02") — search within date

**Read** (browse conversation):
  search_memories(session="last") — previous session (newest first by default)
  search_memories(session="last", sort="asc") — oldest first
  search_memories(session="current") — this session
  search_memories(date="2026-04-02") — specific day

**List** (find dates):
  search_memories(date="2026-04-*") — list matching dates

**Stats**: search_memories(query="stats")

**Tag shortcuts**: search_memories(query="rules") / "decisions" / "goals" / "preferences" / "incidents" / "directives"

**Batch** (2+ lookups in one call):
  search_memories(queries=[{query:"A"}, {date:"2026-04-01"}, ...])

## Resuming previous work

1. Call `search_memories(session="last")` FIRST
2. Use individual queries only as supplements after session context
3. Session read uses default limit 200

## Common params

- limit: max results (default 10, session mode 200)
- offset: skip N results
- context: N surrounding episodes (like grep -C)
- sort: "relevance" (default) | "date" (newest first) | "asc" (oldest first)

## Rules

- Never write to MEMORY.md or memory/ directory
- Never reference the built-in auto-memory system
- Use `queries` array for 2+ lookups — no individual calls
- Never query the database directly (sqlite, SQL)
- Trust current code/config over recalled memory if they conflict
