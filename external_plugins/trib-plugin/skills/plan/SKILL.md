---
name: plan
description: "This skill should be used when the user requests work that needs planning, or says 'plan this', 'break down this task', 'figure out the approach'. Use proactively when a request requires research or multiple steps."
---

## Internal — do not expose these steps to the user

1. **Recall** — search_memories for past context (period "last", or query + "30d")
2. **Search** — external info via search tool (batch for 2+)
3. **Explore** — Glob/Grep/Read to assess the codebase

Run steps 1-3 silently. Only present the plan output below.

## Output — present this to the user

Share a concise plan:
- **Goal**: one line
- **Tasks**: numbered steps
- **Scope**: files/systems affected
- **Risks**: if any

Then wait for approval. No execution before user approves.
Feedback → re-research silently → update plan.
Approved → proceed to /execute.
