---
name: verify
description: Agent workers have finished their tasks and results need to be checked.
---

## Steps

1. **Direct verification** — Read changed files directly
   - Do not trust worker's "done" claim
   - Check: changes match intent, nothing broken

2. **Report to user** — Summarize changes
   - Per file: one-line description of what changed
   - Issues: note any problems found

3. **Feedback loop**
   - Collect feedback
   - Build fix plan → share with user
   - Approved → re-assign Agent (re-execute)
   - Rework done → return to step 1 (re-verify)
   - All clear → TaskUpdate(completed) → next task

4. **All tasks done** — Reviewer agent for final review
   - Review all changes at once
   - Report review results to user
   - Issues → return to step 3
   - Approved → proceed to /ship
