# Team

Team name is `main` (fixed). SessionStart hook auto-ensures the team exists.
Do NOT call TeamCreate or TeamDelete manually. Spawn errors: never retry, check config and report.

## Setup
- TaskCreate per meaningful unit.
- Spawn: `subagent_type` Worker or Bridge, `run_in_background: true`, `team_name: "main"`, `name: <role>`.
- Do NOT use built-in Explore or Plan subagent types.
- Agent names and presets come from User Workflow / Models sections.

## Reuse vs respawn
Default: **reuse** via SendMessage. Respawn only when context pollution hurts quality or task is completely unrelated.

## Parallel workers
Up to 3 (`worker`, `worker-2`, `worker-3`). More than 3 is counterproductive.

## Bridge pattern
Thin pipe on haiku, forwards to external LLM. Embed explicit session id `:bridge_<role>_<hash>`.
Absolute marketplace path (no `${CLAUDE_PLUGIN_ROOT}`). Wait for SendMessage report (5-30s).

Quick questions: /ask (ask-forwarder).
