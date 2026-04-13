# Team

Team name is `main` (fixed). SessionStart hook auto-ensures the team exists.
Do NOT call TeamCreate or TeamDelete manually. Spawn errors: never retry, check config and report.

## Bridge (external models)
- Use MCP `bridge` tool for external model delegation.
- Scope maps to preset via config.scopes (e.g., reviewer → GPT5.4).
- Session-based: same scope reuses session context (multi-turn).
- Parallel instances: append suffix (reviewer-a, reviewer-b) — prefix-matched to preset.
- No scope = default model. Specify scope only when a different model is needed.
- No Plan phase required for bridge calls.
- User command: `/bridge <scope> <prompt>`.

## Native agents (internal Claude)
- Use Agent tool with `subagent_type: "trib-plugin:Worker"` for Claude-native tasks.
- Spawn: `run_in_background: true`, `team_name: "main"`, `name: <role>`.
- Reuse via SendMessage. Respawn when prior context would interfere.
- Before terminating an agent for respawn, get user approval.
- Plan phase required before spawning native agents.

## Constraints
- `subagent_type` MUST be "trib-plugin:Worker" or "trib-plugin:Bridge".
- NEVER pass subagent_type="Explore" or subagent_type="Plan". ABSOLUTELY FORBIDDEN.
- Keep total active agents reasonable — each one adds context pressure on lead.
