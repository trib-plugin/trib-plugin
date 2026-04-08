---
name: recall
user-invocable: false
description: >
  **RECALL FIRST**: Invoke recall whenever prior context could improve the response.
  This covers any situation where current context alone is insufficient —
  past work, decisions, preferences, patterns, or any prior session knowledge
  that may inform a better answer. Always recall at session start.
  Mid-session, recall whenever the user references something not visible
  in current context or when context may have been compressed.
  Skip ONLY when the request is fully self-contained and past context
  is clearly irrelevant to the response.
  Use trib-memory MCP tools (search_memories, memory_cycle) exclusively.
  Do NOT use file-based memory (MEMORY.md, memory/ directory) or any built-in auto-memory system.
---

Always prioritize search_memories() when context may be incomplete.
To resume previous work, use search_memories(period: "last", sort: "date") with no query to review the most recent session context.
For topic-specific recall, use search_memories(query: "topic keywords") to find relevant past decisions and context.
Storage is automatic. Never write to MEMORY.md or memory/ folder. Never use sqlite/SQL directly.
