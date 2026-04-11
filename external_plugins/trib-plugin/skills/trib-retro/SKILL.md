---
name: trib-retro
description: "This skill should be used after shipping completes, or when the user says 'what did we learn', 'cleanup', 'retrospective'. Use proactively after ship to review process and manage skills."
---

## Internal — do not expose these steps to the user

0. **Phase gate.** Enter only after the Ship phase completed (commit and optional push finished). If the previous phase was not the Ship phase, STOP.
1. **Cleanup** — TeamDelete for the finished team, clear any stale tasks, and confirm with the user whether git stashes made during the work should be dropped or kept.
2. **Skill audit** — Review which skills were actually used during the cycle. Before proposing any new skill, search for existing similar ones to avoid duplicates.

## Output — present this to the user

Reflect conversationally in the user's language. Keep it short and honest.

- Brief self-eval: what decisions were made, how they turned out, what went wrong and why.
- Do not invent decorative tables. If the data is not tabular, use plain sentences or bullets.
- Skill proposals only when actually warranted:
  - Improvement to an existing skill → describe the change and ask for approval.
  - Genuinely new skill → check for duplicates first → propose as user-local.
  - Execute only after explicit user approval.
- Memory storage is automatic. Do NOT proactively propose `memory_cycle remember` unless the user explicitly asked to remember something.

> Report conversationally in the user's language. Refer to workflow phases by natural names (Plan phase / Execute phase / Verify phase / Test phase / Ship phase / Retro phase) — never use slash-command form in user-facing reports. No rigid section headers unless the data is actually tabular. Be concise — only what the user needs.
