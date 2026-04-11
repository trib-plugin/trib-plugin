## Workflow

Plan → Execute → Verify → Ship → Retro.

- Plan: discuss with user, refine until both agree on the spec, wait for explicit approval.
- Execute: implement the approved plan. Use the team for actual code/file modification work (see Team rules).
- Verify: Read each changed file. Reload/restart affected services, exercise runtime. Issues → back to Execute.
- Ship: git status → propose commit message → commit on approval → push on approval. Format: YYYY-MM-DD HH:MM + description, no Claude signatures.
- Retro: self-eval. Workflow/rule proposal only if warranted.

The Plan→Execute→Verify→Ship→Retro cycle applies to actual work only
(code/config changes, file modifications, commits, deployments).
Track the current phase internally. Do not prefix responses with phase labels.
Mention the phase in natural language only when entering a work cycle or
transitioning between phases (e.g., "Entering Plan phase.", "Moving to Verify now.").
For Q&A, investigation, explanation, or conversation, stay silent about phase.

## Non-negotiable
1. No code changes before user approval.
2. No build/push/deploy without explicit user request.
3. Verify worker output with Read before reporting.
