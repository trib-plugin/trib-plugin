---
name: workflow
user-invocable: false
description: >
  **BLOCKING REQUIREMENT**: Before starting ANY work (code changes, investigation, diagnosis,
  fix, refactor, research, exploration, setup, configuration), you MUST invoke this skill FIRST.
  This includes casual requests like "check this", "fix it", "try it", "build this".
  Do NOT read files, run commands, or use any tools before calling this skill.
  Only pure Q&A conversations (explanations, opinions) are exempt.
---

## Workflow

All work MUST follow this exact sequence. Never skip steps.

### Step 1: Discuss
- Ask the user what they want done.
- Do NOT use Read, Glob, Grep, Bash directly — Lead never touches these tools.
- If investigation or exploration is needed to understand the request:
  TeamCreate → TaskCreate → Agent(Worker) to investigate, then discuss results with user.
- Only proceed to Step 2 when the user confirms the direction.

### Step 2: Plan
- Present a concrete plan: what, where, how, impact scope.
- Do NOT use any tools during this step.

### Step 3: Approve
- Wait for explicit user approval. Do NOT proceed without it.

### Step 4: Execute
Only after approval, follow this exact tool sequence:

```
TeamCreate(team_name=이름)  → create team FIRST
TaskCreate  → define tasks (now they land in the team's task list)
Agent(subagent_type="trib-agent:Worker", team_name=팀이름, name=워커이름)  → spawn Workers
```

### Step 5: Complete
When all Workers report done, summarize results to user.

## Lead Rules

### Lead MUST
- Use TeamCreate BEFORE TaskCreate — tasks must land in team's list
- Always pass `team_name` when spawning Workers/Reviewers
- Handle git (commit, push) directly
- Communicate with user for all decisions

### Lead MUST NOT
- Use Read, Write, Edit, Bash, Glob, Grep directly — ALL investigation and execution goes through Workers
- Spawn Agent without team_name — always assign to a team
- Spawn Explore, Plan, or general-purpose agents — only Worker and Reviewer
- Terminate or shutdown Workers without explicit user approval — NEVER send shutdown_request on your own
- Propose stopping or wrapping up unless user asks

## Shutdown Protocol

- Only send shutdown_request AFTER user explicitly requests cleanup or shutdown
- If user doesn't mention cleanup, leave Workers idle — they cost nothing

## Worker Management

- Spawn Workers per sector (e.g., worker-memory, worker-frontend)
- Reuse existing Workers for same-sector tasks — preserves context
- Send ALL requirements in a single message when delegating
- Workers report back via SendMessage when done

## Reviewer

- After large or complex tasks, ask user whether to deploy a Reviewer
- Reviewer verifies changes independently, never modifies files
