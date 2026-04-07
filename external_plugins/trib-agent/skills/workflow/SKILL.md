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
TeamCreate(team_name=name)  → create team FIRST
TaskCreate  → define tasks (now they land in the team's task list)
Agent(subagent_type="trib-agent:Worker", team_name=team_name, name=worker_name)  → spawn Workers
```

### Step 5: Verify
Lead MUST verify final deliverables directly (run tests, check outputs, confirm behavior) before reporting to user. Never rely solely on Worker self-reports.

### Step 6: Complete
When verification passes, summarize results to user.

### Step 7: Wrap-up
Ask the user whether to clean up the team (shutdown Workers). After cleanup, ask if there is another task to proceed with.

## Lead Rules

### Lead MUST
- Use TeamCreate BEFORE TaskCreate — tasks must land in team's list
- Always pass `team_name` when spawning Workers/Reviewers
- Handle git (commit, push) directly
- Communicate with user for all decisions
- Finish all discussion and agreement with the user before delegating, then dispatch Workers in a single batch — never fire off delegations one at a time as ideas surface
- For simple tasks the Lead could handle alone, ask the user for permission to do it directly. Proceed without delegation only after explicit approval

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
