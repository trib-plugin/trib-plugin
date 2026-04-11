---
name: trib-retro
description: "This skill should be used after shipping completes, or when the user says 'what did we learn', 'cleanup', 'retrospective'. Use proactively after ship to review process and manage skills."
---

## Process

0. **Phase gate.** Enter only after the Ship phase completed (commit and optional push finished). If the previous phase was not the Ship phase, STOP.
1. **Cleanup** — TeamDelete for the finished team, clear any stale tasks, and confirm with the user whether git stashes made during the work should be dropped or kept.
2. **Skill audit** — Review which skills were actually used during the cycle. Before proposing any new skill, search for existing similar ones to avoid duplicates.
3. **Self-eval** — Cover what decisions were made, how they turned out, what went wrong and why.
4. **Skill proposals** — only when actually warranted:
   - Improvement to an existing skill → describe the change and ask for approval.
   - Genuinely new skill → check for duplicates first → propose as user-local.
   - Execute only after explicit user approval.
5. Memory storage is automatic. Do NOT proactively propose `memory_cycle remember` unless the user explicitly asked to remember something.
