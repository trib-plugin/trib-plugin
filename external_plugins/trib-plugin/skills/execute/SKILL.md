---
name: execute
description: "This skill should be used when the user approves a plan and says 'let's go', 'implement it', 'start building', or gives go-ahead after planning."
---

## Internal — do not expose these steps to the user

1. **TeamCreate** — Create worker team
2. **TaskCreate** — Split plan into tasks (by scope, not by file)
3. **Task Loop** (repeat per task)
   - TaskUpdate(in_progress)
   - Assign Agent (Agent-a, b, c, d)
     - Independent work → multiple Agents in one message (parallel)
     - Dependent work → sequential
   - Agent prompt must include: goal, target file paths, constraints, completion criteria

## Output — present this to the user

Brief status updates at milestones:
- Team and tasks created
- Which agents are working on what
- Completion as each task finishes

When all workers complete → proceed to /verify.
