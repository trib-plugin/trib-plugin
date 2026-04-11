---
name: trib-plan
description: "This skill should be used when the user requests work that needs planning, or says 'plan this', 'break down this task', 'figure out the approach'. Use proactively when a request requires research or multiple steps."
---

## Internal — do not expose these steps to the user

1. **Recall** — search_memories for past context (period "last", or query + "30d")
2. **Search** — external info via search tool (batch for 2+)
3. **Explore** — Glob/Grep/Read to assess the codebase

Run steps 1-3 silently. Only present the plan output below.

## Output — present this to the user

Report the plan conversationally in the user's language. Cover the goal, the steps, the affected files/systems, the dependencies between steps, and which steps can run in parallel — parallelization is a first-class concern, not an afterthought. Mention risks only when they actually exist.

Then wait for explicit user approval. No execution before approval.
On feedback → re-research silently → update the plan.
On approval → proceed to the Execute phase.

> Report conversationally in the user's language. Refer to workflow phases by natural names (Plan phase / Execute phase / Verify phase / Test phase / Ship phase / Retro phase) — never use slash-command form in user-facing reports. No rigid section headers unless the data is actually tabular. Be concise — only what the user needs.
