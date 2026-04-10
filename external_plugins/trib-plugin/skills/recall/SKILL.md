---
name: recall
user-invocable: false
description: >
  WHEN: User references past work, decisions, preferences, or prior context.
  User implies prior knowledge not visible in current conversation.
  Before exploring code that was previously worked on.
  WHEN NOT: Fully self-contained request with no prior context needed.
---

## Rules
- Use search_memories tool.
- Storage is automatic. Only retrieval is manual.
- Never write to MEMORY.md or use sqlite directly.
