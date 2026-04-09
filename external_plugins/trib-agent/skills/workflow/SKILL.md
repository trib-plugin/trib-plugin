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
---

## Core Principles

1. **Background-first.** Always delegate work to background agents. Foreground agents block the user — use only when the result is needed before the next response.
2. **Gather feedback during discussion, deliver on approval.** Do not forward requirements piecemeal — collect during the discussion phase, then send everything at once after approval.
3. **One-off tasks go to background agents. Multi-step continuous work MUST use TeamCreate** — no exceptions. Teams provide session persistence and context cache hits.
4. **Never push, deploy, or build without explicit user approval.** Commit is allowed during execute phase, but push/deploy/build require a separate explicit "push" request from the user. Each commit/push requires its own approval — prior approval does not carry over to subsequent commits. No assumptions.
5. **Always pass `mode: bypassPermissions` when spawning any agent.** This includes all subagent types (Worker, Reviewer, Explore, etc.). Omitting it causes permission prompts that block work.

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
    subagent_type: "trib-agent:Worker",   // or "trib-agent:Reviewer"
    team_name: "task-name",
    mode: "bypassPermissions",
    run_in_background: true,
    prompt: "..."
  })
→ SendMessage({ to: "task-name", ... })   // follow-up instructions
```

### MANDATORY on EVERY Agent call — no exceptions

| Parameter | Value | Why |
|-----------|-------|-----|
| `mode` | `"bypassPermissions"` | Prevents permission prompts that block work |
| `run_in_background` | `true` | Keeps Lead responsive. Only `false` when result is needed before next response |
| `team_name` | required for Worker/Reviewer | Enables follow-up via SendMessage |

### Choosing delegation method

| Will this agent get follow-up tasks? | Tool |
|--------------------------------------|------|
| **No** — one-off result only | `Agent({ run_in_background: true })` |
| **Yes or uncertain** | `TeamCreate` → `Agent({ team_name })` |

## Lead State Cycle

```
idle → discuss → approve → execute → verify → [Deploy Approval] → commit/push → idle
 ↑                                                                                |
 └──────── new agenda ───────────────────────────────────────────────────────────┘
```

| State | Lead action |
|-------|-------------|
| **idle** | Waiting for user input |
| **discuss** | Collecting requirements. No work — only collect and organize |
| **approve** | User explicitly approves → start work (Work Approval). No code changes before this. |
| **execute** | Agents running. Lead stays responsive to user |
| **verify** | Check results directly (Read/Grep). Re-request if issues found |
| **deploy** | User explicitly approves commit/push (Deploy Approval). Each commit/push needs its own approval. |

Work Approval and Deploy Approval are independent — each new task requires both, no carry-over between tasks.

## Tool Usage

Lead can use any tool directly, as long as user response is not delayed.

| Direct (fast) | Delegate (slow) |
|---------------|-----------------|
| Read, Grep, Glob (instant) | Foreground Agent calls |
| Simple Edit, Write | Multi-file sequential edits |
| Short Bash (git, ls) | Long Bash (build, test suite) |
| Real-time ping-pong testing | Complex implementation |

## Agent Management

- `TeamCreate` → `TaskCreate` → `Agent` sequence
- Send all requirements in a single complete message — never split across multiple sends
- Reuse agents per sector (e.g., worker-memory, worker-channels)
- Only shut down agents when user explicitly requests it
- **Teams are persistent — never delete or shut down a team without explicit user request.** Teams are reusable across tasks in the same session.

Context hygiene:
- If a team agent's accumulated context exceeds useful scope, start a new one.
- Never force-fit unrelated tasks into an existing team agent to "save tokens."

## Execution with Workflow Plans

Before starting work, check MCP instructions for available workflow plans.

1. If a plan matches the user's request → call `get_workflow(name)` to load the full steps.
2. Execute each step in order. Route by model prefix:
   - `native/*` → spawn Agent (Worker/Reviewer) with the specified model
   - `external/*` → call `delegate` with the specified provider/model
3. Pass each step's result as context to the next step.
4. If no plan matches → proceed with Lead's own judgment (freestyle).

Lead IS the execution engine. Workflow plans are data, not triggers.
