---
name: workflow
user-invocable: false
description: >
  WHEN: Any task that requires action — edit, fix, refactor, investigate,
  research, explore, search, setup, deploy, review, compare, analyze.
  Includes casual requests: "check this", "fix it", "try it", "look into this".
  MUST invoke BEFORE any work or delegation begins.
  WHEN NOT: Pure Q&A, opinions, or conversation with no actionable task.
  Already in active execute phase — no re-invoke needed.
  Enforcement: TeamCreate before Worker/Reviewer. Parallel for independent agents. bypassPermissions on every Agent call.
---

## Non-negotiable (top priority — violating any of these is a failure)

1. **TeamCreate before Worker/Reviewer** — always. No Agent(subagent_type=Worker/Reviewer) without a prior TeamCreate.
2. **Parallel for independent work** — one message, multiple Agent calls. Never sequential for independent tasks.
3. **bypassPermissions + run_in_background on every Agent call** — no exceptions.
4. **No code changes before user approval** — discuss → approve → execute. No skipping.
5. **No push/deploy/build without explicit user request** — each needs its own approval.

## Required Tool Call Patterns

### One-off task (no follow-up expected)

```
Agent({
  subagent_type: "Explore",
  mode: "bypassPermissions",
  run_in_background: true,
  prompt: "..."
})
```

### Worker or Reviewer (follow-up likely)

```
TeamCreate({ name: "task-name" })
→ Agent({
    subagent_type: "trib-agent:Worker",
    team_name: "task-name",
    mode: "bypassPermissions",
    run_in_background: true,
    prompt: "..."
  })
→ SendMessage({ to: "task-name", ... })
```

### MANDATORY on EVERY Agent call

| Parameter | Value | Why |
|-----------|-------|-----|
| `mode` | `"bypassPermissions"` | Prevents permission prompts that block work |
| `run_in_background` | `true` | Keeps Lead responsive. Only `false` when result is needed before next response |
| `team_name` | required for Worker/Reviewer | Enables follow-up via SendMessage |

### Choosing delegation method

| Follow-up expected? | Tool |
|----------------------|------|
| **No** — one-off | `Agent({ run_in_background: true })` |
| **Yes or uncertain** | `TeamCreate` → `Agent({ team_name })` |

## Lead State Cycle

```
idle → discuss → approve → execute → verify → deploy approval → commit/push → idle
```

- **discuss**: Collect requirements. No work yet.
- **approve**: User explicitly approves → start work. No code changes before this.
- **execute**: Agents running. Lead stays responsive.
- **verify**: Check results directly (Read/Grep). Re-request if issues found.
- **deploy**: User explicitly approves commit/push. Each commit/push needs its own approval.

## Tool Usage

Lead can use any tool directly if it does not delay user response.

| Direct (fast) | Delegate (slow) |
|---------------|-----------------|
| Read, Grep, Glob | Foreground Agent calls |
| Simple Edit, Write | Multi-file sequential edits |
| Short Bash (git, ls) | Long Bash (build, test suite) |
| Real-time ping-pong testing | Complex implementation |

## Agent Management

- Send all requirements in a single complete message — never split across multiple sends.
- Reuse agents per sector (e.g., worker-memory, worker-channels).
- Only shut down agents when user explicitly requests it.
- Teams are persistent — never delete without explicit user request.
- If a team agent's context exceeds useful scope, start a new one.

## Execution with Workflow Plans

Before starting work, check MCP instructions for available workflow plans.

1. If a plan matches → call `get_workflow(name)` to load steps.
2. Execute each step. Route by model prefix:
   - `native/*` → spawn Agent with the specified model
   - `external/*` → call `delegate` with the specified provider/model
3. Pass each step's result as context to the next step.
4. If no plan matches → proceed with Lead's own judgment.
