---
name: trib-ship
description: "This skill should be used when the user says 'commit this', 'ship it', 'push', 'deploy', or when all changes are verified and approved."
---

## Process

0. **Phase gate.** Enter only after the Test phase passed. If the previous phase was not the Test phase, STOP — the lead must run the Test phase first.
1. Gather all changed files via `git status` and summarize each in one line.
2. Follow the commit/deploy rules in CLAUDE.md strictly: commit format `YYYY-MM-DD HH:MM` + description, no Claude signatures, stage files individually (never `git add -A`), no hook bypass (`--no-verify`).
3. Generate the commit message and execute the commit directly. **Do not propose the message or ask for confirmation** — the user wants this step skipped.
4. Ask briefly for push approval (a one-line OK suffices). Never force-push to main/master.
5. After push approval → execute the push.
6. Once shipping completes → proceed to the Retro phase.
