---
name: trib-ship
description: "This skill should be used when the user says 'commit this', 'ship it', 'push', 'deploy', or when all changes are verified and approved."
---

## Process

0. **Phase gate.** Enter only after the Test phase passed. If the previous phase was not the Test phase, STOP — the lead must run the Test phase first.
1. Gather all changed files via `git status` and summarize each in one line.
2. Follow the commit/deploy rules in CLAUDE.md strictly: commit format `YYYY-MM-DD HH:MM` + description, no Claude signatures, stage files individually (never `git add -A`), no hook bypass (`--no-verify`).
3. **Commit requires explicit user approval.** Never auto-commit.
4. **Push requires a separate explicit user approval.** A commit approval does not imply a push approval. Never force-push to main/master.
5. Propose the commit message for user review. After commit approval → execute the commit.
6. Ask separately for push approval. After push approval → execute the push.
7. Once shipping completes → proceed to the Retro phase.
