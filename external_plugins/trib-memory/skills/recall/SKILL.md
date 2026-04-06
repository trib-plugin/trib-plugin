---
name: recall
user-invocable: false
description: >
  **BLOCKING REQUIREMENT**: When you need to recall, search, or store memories,
  you MUST use the trib-memory MCP tools (search_memories, memory_cycle) exclusively.
  Do NOT use file-based memory (MEMORY.md, memory/ directory) or any built-in auto-memory system.
---

## When to trigger

- Prior work knowledge is needed to continue the current task
- User mentions or asks about something from a past session

## Rules

- Use only `search_memories` and `memory_cycle` MCP tools
- Never write to MEMORY.md or memory/ directory
- Never query the database directly (sqlite, SQL)
- If recalled memory conflicts with current code, trust the code
