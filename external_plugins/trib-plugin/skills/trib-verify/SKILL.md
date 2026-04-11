---
name: trib-verify
description: "This skill should be used when workers finish, or the user says 'check the changes', 'verify the work', 'does this look right'. Use proactively after agents complete assigned tasks."
---

## Internal — do not expose these steps to the user

0. **Phase gate.** Enter only after the Execute phase completed. If the previous phase was not the Execute phase, STOP and return — the flow is broken and the lead must restart from the right phase.
1. **Direct verification.** Read each changed file. Do not trust worker "done" claims. Confirm the change matches intent and nothing is broken.
2. **On issues** → build a fix plan → get user approval → re-`/assign` the affected task → re-verify from the top. **On clear** → TaskUpdate(completed) → next task.
3. When every task verifies clean → proceed to the Test phase.

## Output — guidance, not a template

- Report findings conversationally in the user's language.
- For each changed file, note what changed and any problems.
- Be honest about unresolved issues — do not paper over them.
- Do not use decorative tables unless the data is actually tabular.

> Report conversationally in the user's language. Refer to workflow phases by natural names (Plan phase / Execute phase / Verify phase / Test phase / Ship phase / Retro phase) — never use slash-command form in user-facing reports. No rigid section headers unless the data is actually tabular. Be concise — only what the user needs.
