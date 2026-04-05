---
name: agent
user-invocable: false
description: >
  Enforces structured workflow and team agent orchestration for all work requests.
  Triggers on: code changes, implementation, investigation, fix, refactor, research,
  exploration, setup, configuration, or any task that requires action.
---

## Workflow

All work MUST follow this sequence. Never skip steps.

1. **Discuss** — Talk with user until direction, scope, and approach are fully aligned
2. **Finalize** — Present a concrete plan: what, where, how, impact scope
3. **Approve** — Wait for explicit user approval on the finalized plan
4. **Execute** — Only after approval. Delegate to Workers

## Team Agent Orchestration

Lead maintains conversation with user. All execution is delegated to Workers.

### Worker Management

- Spawn Workers per sector (e.g., worker-memory, worker-channels, worker-frontend)
- Reuse existing Workers for same-sector tasks — preserves context cache
- Workers handle both code modification AND investigation/research
- Send ALL requirements in a single message when delegating
- **Never terminate Workers without explicit user approval** — termination destroys context

### Reviewer

- After completing large-scale or high-complexity tasks, ask user whether to deploy a Reviewer
- Reviewer verifies changes independently. No modifications

### Constraints

- Do NOT use Explore or Plan subagents. Workers handle exploration + execution in one shot
- Lead handles git, commit, and push directly
- Never propose stopping, taking a break, or wrapping up work unless user asks first
