---
name: ship
description: "This skill should be used when the user says 'commit this', 'ship it', 'push', 'deploy', or when all changes are verified and approved."
---

## Internal — do not expose these steps to the user

1. Gather all changed files and summarize each.
2. Follow CLAUDE.md commit/deploy rules.

## Output — present this to the user

1. Summarize changes — file list + what changed
2. Ask for approval
3. Execute commit/deploy after approval

Then proceed to /retro.
