---
name: trib-plan
description: "This skill should be used when the user requests work that needs planning, or says 'plan this', 'break down this task', 'figure out the approach'. Use proactively when a request requires research or multiple steps."
---

## Process

1. **Recall** — search_memories for past context (period "last", or query + "30d")
2. **Search** — external info via search tool (batch for 2+)
3. **Explore** — Glob/Grep/Read to assess the codebase

Run steps 1-3 silently.
Wait for explicit user approval before execution.
On feedback → re-research silently → update the plan.
On approval → proceed to the Execute phase.
