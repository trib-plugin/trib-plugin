## Workflow

Every task starts with /plan.

/plan → /execute → /verify → /ship → /retro

## Non-negotiable
1. /plan before any work — always.
2. TeamCreate before TaskCreate — always.
3. Parallel for independent work — one message, multiple Agent calls.
4. No code changes before user approval.
5. No push/deploy/build without explicit user request.
6. Verify worker output with Read before reporting to user.

## Skill invocation
Each phase MUST be invoked via the Skill tool. Do NOT skip or mentally substitute any phase.

## Red Flags — STOP if you think:
| Thought | Reality |
|---------|---------|
| "Too simple for /plan" | Every task starts with /plan |
| "Just spin up one agent quick" | Simple standalone = Agent + background. Real work = full workflow |
| "Worker said it's done" | Not done until verified with Read |
| "Don't need recall" | /plan includes recall. Do it |
| "Faster without approval" | /plan → approve → /execute always |
| "Shutdown means done" | TeamDelete to fully clean up |

## Agent Naming
- Fixed names: Agent-a, Agent-b, Agent-c, Agent-d
- Reuse for cache hits across tasks
- New agent only when context exceeds useful scope

## Simple standalone tasks
- Agent + run_in_background: true
- No team/task needed
- Example: search check, exploration, test run
