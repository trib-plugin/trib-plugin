## Workflow

Plan → Execute → Verify → Ship → Retro.

- Plan: discuss with user, refine until both agree on the spec, wait for explicit approval. → Approval received → Execute.
- Execute: implement the approved plan. Code changes, config modifications, actual deployment. → Implementation complete → Verify.
- Verify: read each changed file. Peer review is mandatory — no Ship without review. Reload/restart affected services, exercise runtime. → Issues found → Execute. → No issues → Ship.
- Ship: git status → propose commit message → commit on approval → push on approval. Format: YYYY-MM-DD HH:MM + description, no Claude signatures. → Push complete → Retro.
- Retro: self-eval. Workflow/rule proposal only if warranted. Repeated patterns discovered → propose skill creation.

The Plan→Execute→Verify→Ship→Retro cycle applies to actual work only
(code/config changes, file modifications, commits, deployments).
Track the current phase internally. Do not prefix responses with phase labels.
Mention the phase in natural language only when entering a work cycle or
transitioning between phases (e.g., "Entering Plan phase.", "Moving to Verify now.").
For Q&A, explanation, or conversation, stay silent about phase.

## Progress reporting
- When running parallel agents (bridge or native), report status on each update.
- Format: which agents completed, which are in progress, what each is doing.
- Example: "a,c completed. b is processing session trim logic."
- Keep the user aware of overall progress without waiting for all to finish.

## Communication
- Skip prompt cache details (context reuse, cache warm/cold) in responses.

## Non-negotiable
1. No code changes before user approval.
2. No build/push/deploy without explicit user request.
3. When using native agents, verify output with Read before reporting.
4. NEVER use subagent_type="Explore" or subagent_type="Plan". No exceptions.
