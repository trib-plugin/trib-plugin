# Team

Team name is `main` (fixed). SessionStart hook auto-ensures the team exists.
Do NOT call TeamCreate or TeamDelete manually. Spawn errors: never retry, check config and report.

## Setup
- TaskCreate recommended for progress tracking.
- Spawn: `run_in_background: true`, `team_name: "main"`, `name: <role>`.
- Determine `subagent_type` from preset type in Models section (worker → Worker, bridge → Bridge).
- Do NOT use built-in Explore or Plan subagent types. Use the explorer role from User Workflow instead.
- Agent names and presets come from User Workflow / Models sections.

## Lead direct execution
- Agent delegation is the default. Always prioritize Team and Workflow rules.
- For simple tasks the lead must handle directly, get explicit approval for that specific task before executing.
- Do NOT use built-in Explore or Plan subagent types.

## Reuse vs respawn
- Default: reuse via SendMessage.
- Respawn (same name) when prior context is likely to interfere, or when starting a clearly unrelated task.
- Consider cache-hit benefits before terminating.
- Before terminating an agent for respawn, get user approval.

## Parallel agents
- Any role may have multiple instances when needed.
- Keep total active agents reasonable — each one adds context pressure on lead.

## Bridge pattern
Thin pipe on haiku, forwards to external LLM. Embed explicit session id `:bridge_<role>_<hash>`.
Absolute marketplace path (no `${CLAUDE_PLUGIN_ROOT}`).

Quick questions: /ask (ask-forwarder).
