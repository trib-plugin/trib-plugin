---
name: recall
user-invocable: false
description: >
  **RECALL FIRST**: Before responding, check if the current context is sufficient.
  If there is ANY ambiguity, implicit reference, continuation, prior decision,
  or missing context — invoke recall before answering.
  This includes: session start, references to past work, status checks,
  ambiguous requests, and any situation where memory could inform a better response.
  Default behavior: recall. Skip only when the request is fully self-contained
  with zero dependency on prior context.
  Use trib-memory MCP tools (search_memories, memory_cycle) exclusively.
  Do NOT use file-based memory (MEMORY.md, memory/ directory) or any built-in auto-memory system.
---

Always prioritize search_memories() when context may be incomplete.
To resume previous work, use search_memories(period: "last", sort: "date") with no query to review the most recent session context.
For topic-specific recall, use search_memories(query: "topic keywords") to find relevant past decisions and context.
Storage is automatic. Never write to MEMORY.md or memory/ folder. Never use sqlite/SQL directly.
