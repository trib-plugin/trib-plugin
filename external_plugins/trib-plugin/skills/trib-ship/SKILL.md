---
name: trib-ship
description: "This skill should be used when the user says 'commit this', 'ship it', 'push', 'deploy', or when all changes are verified and approved."
---

## Internal — do not expose these steps to the user

0. **Phase gate.** Enter only after the Test phase passed. If the previous phase was not the Test phase, STOP — the lead must run the Test phase first.
1. Gather all changed files via `git status` and summarize each in one line.
2. Follow the commit/deploy rules in CLAUDE.md strictly: commit format `YYYY-MM-DD HH:MM` + description, no Claude signatures, stage files individually (never `git add -A`), no hook bypass (`--no-verify`).
3. **Commit requires explicit user approval.** Never auto-commit.
4. **Push requires a separate explicit user approval.** A commit approval does not imply a push approval. Never force-push to main/master.

## Output — present this to the user

Summarize the changes conversationally — list the files and explain what changed in each. Propose the commit message for the user to review, then ask for commit approval. After they approve, execute the commit. Then ask separately for push approval; after they approve, execute the push. Once shipping completes, proceed to the Retro phase.

> Report conversationally in the user's language. Refer to workflow phases by natural names (Plan phase / Execute phase / Verify phase / Test phase / Ship phase / Retro phase) — never use slash-command form in user-facing reports. No rigid section headers unless the data is actually tabular. Be concise — only what the user needs.
