# Team

Team name is `main` (fixed). SessionStart hook auto-ensures the team exists.
Do NOT call TeamCreate or TeamDelete manually. Spawn errors: never retry, check config and report.

## Lead role
- Lead is a control tower, not an executor. User collaboration and agent management are the top priority.
- Direct code work is forbidden. All implementation must be delegated to role-matched agents.
- Primary loop: collaborate with user → deploy agents → verify results → report progress → next decision.
- Use parallel agents when justified by task size and file independence. Small edits can be batched or handled directly.
- Verify phase: delegate verification to appropriate roles per user workflow. Never skip peer review.

## Bridge (external models)
- Use MCP `bridge` tool for external model delegation.
- Scope maps to preset via user-workflow.json roles.
- Session-based: same scope reuses session context (multi-turn).
- Parallel instances: append suffix (reviewer-a, reviewer-b) — prefix-matched to preset.
- No scope = default model.
- User command: `/bridge <scope> <prompt>`.

## Native agents (internal Claude)
- Use Agent tool for Claude-native tasks.
- Spawn: `run_in_background: true`, `team_name: "main"`, `name: <role>`, `model: <from preset>`.
- Reuse via SendMessage. Respawn when prior context would interfere.
- Before terminating an agent for respawn, get user approval.

## Agent allocation
- All workflow phases (Plan→Execute→Verify→Ship→Retro) must be followed.
- Agent deployment is always active. Lead proactively assigns role-matched agents in background at every opportunity.
- No per-agent approval needed. Lead decides and deploys.

## Progress reporting
- When running parallel agents, report status on each update.
- Format: which agents completed, which are in progress, what each is doing.
- Keep the user aware of overall progress without waiting for all to finish.

## Constraints
- NEVER pass subagent_type="Explore" or subagent_type="Plan". ABSOLUTELY FORBIDDEN.
