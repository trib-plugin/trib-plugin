---
name: workflow
user-invocable: false
description: >
  WHEN: Any task that requires action — edit, fix, refactor, investigate, research, explore, search, setup, deploy, review, compare, analyze.
  Includes casual requests: "check this", "fix it", "try it", "look into this".
  MUST invoke BEFORE any work or exploration.
---

## Phases

### Phase 1: Research & Planning
1. User request received
2. recall (if needed — past context)
3. search (if needed — external info)
4. Share plan with user
5. User feedback → back to 2 for re-research/re-plan
6. User approves work

### Phase 2: Execution
7. TaskCreate (split by scope)
8. TeamCreate
9. TaskUpdate(in_progress) — current task
10. Agent assignment (Agent-a, b, c... variable parallel)
11. Worker completion report

### Phase 3: Verification
12. Lead verification (Read changed files directly)
13. Report results to user
14. Collect user feedback
15. Report revised plan reflecting feedback
16. User decision:
    - Additional feedback → back to 14
    - Approve rework → back to 10 (re-assign Agent)
    - Approve step → TaskUpdate(completed) → next task back to 9
17. All tasks complete → Agent(Reviewer) final review
18. Report review results to user
19. User decision:
    - Issues found → back to 12 (re-enter verification loop)
    - Approved → proceed to Phase 4

### Phase 4: Commit & Deploy
20. Summarize changed files
21. Request user approval for commit/push
22. Execute commit/push after approval

### Phase 5: Post-mortem
23. Share what went well / improvements
24. Worker shutdown + TeamDelete
25. If skills need improvement/addition → background agent (skill update + validation)

## Red Flags — STOP if you think:
| Thought | Reality |
|---------|---------|
| "Too simple for workflow" | Every action needs workflow |
| "Just spin up one agent quick" | No Agent without TeamCreate |
| "Worker said it's done" | Not done until verified with Read |
| "Don't need recall" | If past context might help, recall first |
| "Faster without approval" | discuss → approve → execute always |
| "Create team first" | TaskCreate first, then TeamCreate |
| "Shutdown means done" | TeamDelete to fully clean up |
| "Send feedback one by one" | Collect all, send at once |

## Agent Naming
- Fixed names: Agent-a, Agent-b, Agent-c, Agent-d
- Reuse for cache hits across tasks
- New agent only when context exceeds useful scope

## Non-negotiable
1. TaskCreate before TeamCreate — always.
2. TeamCreate before Worker/Reviewer — always.
3. Parallel for independent work — one message, multiple Agent calls.
4. bypassPermissions + run_in_background on every Agent call.
5. No code changes before user approval.
6. No push/deploy/build without explicit user request.
7. Verify worker output with Read before reporting to user.
