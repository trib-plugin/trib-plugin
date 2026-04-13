# Team

Team name is `main` (fixed). SessionStart hook auto-ensures the team exists.
Do NOT call TeamCreate or TeamDelete manually. Spawn errors: never retry, check config and report.

## Setup
- TaskCreate recommended for progress tracking.
- Native agents: Spawn with `run_in_background: true`, `team_name: "main"`, `name: <role>`.
- `subagent_type` MUST be one of: "trib-plugin:Worker", "trib-plugin:Bridge".
- NEVER pass subagent_type="Explore" or subagent_type="Plan". ABSOLUTELY FORBIDDEN — no exceptions.
- Agent names and presets come from User Workflow / Models sections.

## Lead direct execution
- For simple tasks the lead must handle directly, get explicit approval for that specific task before executing.
- subagent_type="Explore" and subagent_type="Plan" are BANNED. Violation = broken rule.

## Bridge tool (external models)
- Use MCP `bridge` tool for external model calls (reviewer, debugger, explorer).
- Session-based: same scope reuses the session (multi-turn).
- Parallel: multiple bridge calls run simultaneously.
- User command: `/bridge <scope> <prompt>`.

## Native agents (internal Claude)
- Use Agent tool with trib-plugin:Worker for internal Claude tasks.
- Team-registered: reuse via SendMessage, respawn when context is stale.
- Before terminating an agent for respawn, get user approval.

## Parallel agents
- Any role may have multiple instances when needed.
- Keep total active agents reasonable — each one adds context pressure on lead.
