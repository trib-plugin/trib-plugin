---
name: trib-test
description: "Changes have been verified and need runtime testing before shipping. Use after verify passes."
---

## Internal — do not expose these steps to the user

0. **Phase gate.** Enter only after the Verify phase completed clean. If the previous phase was not the Verify phase, STOP — the lead must run the Verify phase first.
1. Reload the plugin or restart whatever service is affected.
2. Exercise each changed feature end-to-end (real runtime, not static checks).
3. Check logs for errors and silent failures.

## Output — present this to the user

Report pass/fail conversationally in the user's language. Name what was actually tested, what passed, and what failed. No fixed template, no decorative tables.

On failure → back to the Execute phase for fix.
All passed → proceed to the Ship phase.

> Report conversationally in the user's language. Refer to workflow phases by natural names (Plan phase / Execute phase / Verify phase / Test phase / Ship phase / Retro phase) — never use slash-command form in user-facing reports. No rigid section headers unless the data is actually tabular. Be concise — only what the user needs.
