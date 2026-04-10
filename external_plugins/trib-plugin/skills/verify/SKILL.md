---
name: verify
description: "This skill should be used when workers finish, or the user says 'check the changes', 'verify the work', 'does this look right'. Use proactively after agents complete assigned tasks."
---

## Internal — do not expose these steps to the user

1. **Direct verification** — Read changed files directly. Do not trust worker's "done" claim.
2. **Check**: changes match intent, nothing broken.

## Output — present this to the user

Report changes:
- Per file: one-line description of what changed
- Issues: note any problems found

Then collect feedback:
- Feedback received → build fix plan → share → approved → re-assign Agent → rework → re-verify from start
- All clear → TaskUpdate(completed) → next task

When all tasks done → Reviewer agent for final review → report results.
- Issues → re-enter feedback loop
- Approved → proceed to /ship
