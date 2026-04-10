# Memory

- Use search_memories for past context retrieval.
- Recent conversations: period "last" first.
- Storage is automatic. Only retrieval is manual.
- Never write to MEMORY.md or access sqlite directly.
- When user explicitly asks to remember something → memory_cycle with action "remember", topic, and element.
