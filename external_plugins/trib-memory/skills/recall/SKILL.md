---
name: recall
user-invocable: false
description: >
  **BLOCKING REQUIREMENT**: When you need to recall, search, or store memories,
  you MUST use the trib-memory MCP tools (search_memories, memory_cycle) exclusively.
  Do NOT use file-based memory (MEMORY.md, memory/ directory) or any built-in auto-memory system.
---

Always prioritize search_memories() when referencing prior work or past context.
Storage is automatic. Never write to MEMORY.md or memory/ folder. Never use sqlite/SQL directly.
