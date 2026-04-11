---
name: trib-test
description: "Changes have been verified and need runtime testing before shipping. Use after verify passes."
---

## Process

0. **Phase gate.** Enter only after the Verify phase completed clean. If the previous phase was not the Verify phase, STOP — the lead must run the Verify phase first.
1. Reload the plugin or restart whatever service is affected.
2. Exercise each changed feature end-to-end (real runtime, not static checks).
3. Check logs for errors and silent failures.

On failure → back to the Execute phase for fix.
All passed → proceed to the Ship phase.
