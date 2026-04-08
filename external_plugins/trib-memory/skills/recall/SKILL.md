---
name: recall
user-invocable: false
description: >
  WHEN: Session start — ALWAYS invoke, no exceptions.
  References to past work, decisions, preferences, or prior context.
  User mentions something not visible in current conversation.
  Context has been compressed or truncated.
  Resuming work from a previous session.
  WHEN NOT: Fully self-contained request with no prior context needed.
  Use search_memories() only — never file-based memory.
---

## Tool Call Patterns

### Session start (always)
```
mcp__trib-memory__search_memories({ period: "last", sort: "date" })
```

### Topic-specific recall
```
mcp__trib-memory__search_memories({ query: "topic keywords" })
```

### Date-specific recall
```
mcp__trib-memory__search_memories({ query: "topic", period: "2026-04-07" })
```

### Recall by importance tag
```
mcp__trib-memory__search_memories({ query: "rules" })
mcp__trib-memory__search_memories({ query: "decisions" })
mcp__trib-memory__search_memories({ query: "preferences" })
```

## Rules

- ALWAYS invoke at session start with `period: "last"` to load previous session context.
- Use `search_memories()` only — never write to MEMORY.md or memory/ folder.
- Never use sqlite/SQL directly.
- Storage is automatic. Only retrieval is manual.
