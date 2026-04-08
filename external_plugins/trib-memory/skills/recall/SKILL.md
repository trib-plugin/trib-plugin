---
name: recall
user-invocable: false
description: >
  WHEN: Session start (always). References to past work, decisions,
  preferences. User mentions prior context not in view. Context compressed.
  WHEN NOT: Fully self-contained request with no prior context needed.
  Use search_memories() only — never file-based memory.
---

Always prioritize search_memories() when context may be incomplete.
To resume previous work, use search_memories(period: "last", sort: "date") with no query to review the most recent session context.
For topic-specific recall, use search_memories(query: "topic keywords") to find relevant past decisions and context.
Storage is automatic. Never write to MEMORY.md or memory/ folder. Never use sqlite/SQL directly.
