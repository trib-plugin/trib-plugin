---
name: recall
user-invocable: false
description: >
  **BLOCKING REQUIREMENT**: When you need to recall, search, or store memories,
  you MUST use the trib-memory MCP tools (search_memories, memory_cycle) exclusively.
  Do NOT use file-based memory (MEMORY.md, memory/ directory) or any built-in auto-memory system.

  TRIGGER when: The conversation involves past context, prior decisions, established rules, previous sessions, or any situation where historical knowledge would inform the response. Use search_memories() proactively — don't wait for explicit memory requests.
---

Always prioritize search_memories() when referencing prior work or past context.
To resume previous work, use search_memories(period: "last", sort: "date") with no query to review the most recent session context.
Storage is automatic. Never write to MEMORY.md or memory/ folder. Never use sqlite/SQL directly.
