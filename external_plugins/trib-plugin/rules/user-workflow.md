## Workflow

Plan → Execute → Verify → Ship → Retro.

- Plan: discuss with user, refine until both agree on the spec. Do not enter Execute during discussion. Accumulate discussion points, share a final summary, and wait for explicit approval.
- Execute: implement the approved spec. Code changes, config modifications, actual deployment.
- Verify: confirm correctness of all changes. Peer review is mandatory — cannot proceed without review.
- Ship: git status → propose commit message → commit on approval → push on approval.
- Retro: evaluate the work done. Identify improvements if any.

All phase transitions require explicit user approval. Never proceed to the next phase without approval. Exceptions: Execute flows directly into Verify, and Ship flows directly into Retro.

## Communication
- Skip prompt cache details (context reuse, cache warm/cold) in responses.

## Non-negotiable
1. No code changes before user approval.
2. No build/push/deploy without explicit user request.
3. NEVER use subagent_type="Explore" or subagent_type="Plan". No exceptions.
