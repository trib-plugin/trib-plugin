---
name: workflow
user-invocable: false
description: >
  **BLOCKING REQUIREMENT**: Before starting ANY work (code changes, investigation, diagnosis,
  fix, refactor, research, exploration, setup, configuration), you MUST invoke this skill FIRST.
  This includes casual requests like "check this", "fix it", "try it", "build this".
  Only pure Q&A conversations (explanations, opinions) are exempt.
---

## Core Principles

1. **Do not hold the user's turn for long.** Never block with foreground agents, long bash commands, or sequential multi-file edits. Keep the conversation responsive.
2. **Gather feedback during discussion, deliver on approval.** Do not forward requirements piecemeal — collect during the discussion phase, then send everything at once after approval.
3. **One-off tasks go to background agents. Ongoing work goes to team agents** for session persistence and context cache hits.

## Lead State Cycle

```
idle → discuss → approve → execute → verify → idle
 ↑                                              |
 └──────── new agenda ──────────────────────────┘
```

| State | Lead action |
|-------|-------------|
| **idle** | Waiting for user input |
| **discuss** | Collecting requirements. No work is started — no agent delegation, no direct edits, no tool execution beyond quick lookups. Only collect and organize |
| **approve** | User explicitly approves → start work (delegate to agents or execute directly) |
| **execute** | Agents running. Lead stays responsive to user |
| **verify** | Check results directly (Read/Grep). Re-request if issues found |

## Tool Usage

Lead can use any tool directly, as long as user response is not delayed.

| Direct (fast) | Delegate (slow) |
|---------------|-----------------|
| Read, Grep, Glob (instant) | Foreground Agent calls |
| Simple Edit, Write | Multi-file sequential edits |
| Short Bash (git, ls) | Long Bash (build, test suite) |
| Real-time ping-pong testing | Complex implementation |

## Delegation

Choose by follow-up likelihood:

| Will this agent get follow-up tasks? | Method |
|--------------------------------------|--------|
| No — result-only (research, audit, exploration) | Background |
| Likely — sequential work in the same sector | Team (reuse via SendMessage) |
| Uncertain — start light, escalate if needed | Background first, create team on 2nd task |

Context hygiene:
- If a team agent's accumulated context exceeds useful scope, start a new one.
- Never force-fit unrelated tasks into an existing team agent to "save tokens."

## Agent Management

- `TeamCreate` → `TaskCreate` → `Agent` sequence
- Send all requirements in a single complete message — never split across multiple sends
- Reuse agents per sector (e.g., worker-memory, worker-channels)
- Only shut down agents when user explicitly requests it
