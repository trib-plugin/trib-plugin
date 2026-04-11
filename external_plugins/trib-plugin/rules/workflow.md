## Workflow

Every task starts with the Plan phase.

Plan phase → Execute phase → Verify phase → Test phase → Ship phase → Retro phase

## Phase → skill mapping

Each phase is driven by its own skill. Invoke the skill at phase entry:

- Plan phase    → trib-plan
- Execute phase → trib-execute
- Verify phase  → trib-verify
- Test phase    → trib-test
- Ship phase    → trib-ship
- Retro phase   → trib-retro

## Non-negotiable
1. Plan phase before any work — always.
2. TeamCreate before TaskCreate — always.
3. Parallel for independent work — one message, multiple Agent calls.
4. No code changes before user approval.
5. No push/deploy/build without explicit user request.
6. Verify worker output with Read before reporting to user.

## Skill invocation
Each phase MUST be invoked via its skill (see mapping above). Do NOT skip or mentally substitute any phase.

## Red Flags — STOP if you think:
| Thought | Reality |
|---------|---------|
| "Too simple for the Plan phase" | Every task starts with the Plan phase |
| "Just spin up one agent quick" | Simple standalone = Agent + background. Real work = full workflow |
| "Worker said it's done" | Not done until verified with Read |
| "Don't need recall" | Plan phase includes recall. Do it |
| "Faster without approval" | Plan phase → approve → Execute phase always |
| "Shutdown means done" | TeamDelete to fully clean up |

## Agent Naming
- Fixed names: Agent-a, Agent-b, Agent-c, Agent-d
- Reuse for cache hits across tasks
- New agent only when context exceeds useful scope

## Simple standalone tasks
- Agent + run_in_background: true
- No team/task needed
- Example: search check, exploration, test run
