---
name: recall
user-invocable: false
description: >
  WHEN: Session start — ALWAYS, no exceptions.
  User references past work, decisions, preferences, or prior context.
  User implies prior knowledge not visible in current conversation.
  Before exploring code that was previously worked on — recall first.
  Context has been compressed or truncated.
  WHEN NOT: Fully self-contained request with no prior context needed.
  Order: recall → search → codebase. Never skip recall when past context may be relevant.
---

## Non-negotiable

- ALWAYS invoke at session start: `period: "last"`, `sort: "date"`.
- When past context may be relevant, recall BEFORE exploring code or searching the web.
- Order: recall (past context) → search (external info) → codebase (Grep/Glob/Read). Never skip a prior step.

## Tool Call Patterns

### Session start (always)
```
mcp__trib-memory__search_memories({ period: "last", sort: "date" })
```

### Past context referenced (user mentions prior work, features, decisions)
```
mcp__trib-memory__search_memories({ query: "relevant keywords" })
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

- Use `search_memories()` only — never write to MEMORY.md or memory/ folder.
- Never use sqlite/SQL directly.
- Storage is automatic. Only retrieval is manual.
