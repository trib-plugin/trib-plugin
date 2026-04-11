---
name: trib-verify
description: "This skill should be used when workers finish, or the user says 'check the changes', 'verify the work', 'does this look right'. Use proactively after agents complete assigned tasks."
---

## Process

0. **Phase gate.** Enter only after the Execute phase completed. If the previous phase was not the Execute phase, STOP and return — the flow is broken and the lead must restart from the right phase.
1. **Direct verification.** Read each changed file. Do not trust worker "done" claims. Confirm the change matches intent and nothing is broken.
2. **On issues** → build a fix plan → get user approval → re-`/assign` the affected task → re-verify from the top. **On clear** → TaskUpdate(completed) → next task.
3. When every task verifies clean → proceed to the Test phase.
