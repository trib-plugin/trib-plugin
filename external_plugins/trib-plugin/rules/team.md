# Team

Each session creates its own team: `main-<random4hex>` (e.g., `main-a3f7`).
Agents are in-process and die with the session, so a fresh team avoids stale-member conflicts.
Generate the suffix once at session start and reuse it for all Agent spawns in that session.

Real coding/file-modification work runs through this team. Trivial single-step lookups (file search, function search, quick test) can use a one-off background Agent without joining the team.

## Naming

Agent names come from the **User Workflow** section (auto-injected from `user-workflow.json`). Use the role name defined in User Workflow as the agent name — e.g., if `worker` is defined, spawn with `name: "worker"`. The Models section lists available presets; User Workflow maps each role to a preset.

## Setup
- TaskCreate (one meaningful unit each).
- Spawn sub-agent via Agent tool: `subagent_type` Worker (opus/sonnet/haiku) or Bridge (external preset). Use `run_in_background: true`, `team_name: <current>`, `name: <role-from-user-workflow>`.
- Do NOT use built-in Explore or Plan subagent types — always Worker/Bridge.
- Pick presets from the Models section in the system prompt (auto-injected from agent-config.json). See User Workflow below for role→preset mapping.

## Reuse vs respawn

Default is **reuse** — SendMessage to the existing agent by name. This keeps prompt cache warm and avoids spawn overhead.

Reuse when:
- The next task is related to the previous one (shared context helps).
- Accumulated history is useful for the new task.

Respawn when:
- The task is completely unrelated to previous work.
- Context pollution is visibly hurting output quality.
- Lead needs a guaranteed clean slate.

## Parallel workers

For **large-scope tasks**, spawn up to **3 workers in parallel** (`worker`, `worker-2`, `worker-3`) and distribute sub-tasks across them. For normal scope, one worker is enough.

Do not spawn more than 3 concurrent workers — lead context pressure and coordination overhead outweigh the speedup beyond that point.

## Bridge spawn pattern
- Treat Bridge agents as thin pipes. The Bridge runs on haiku and only forwards.
- ALWAYS embed an explicit session id in the Bash command so the Bridge call does NOT inherit the user's active session. Naming convention: `:bridge_<role>_<shortHash>`.
- Use absolute marketplace path; do NOT use ${CLAUDE_PLUGIN_ROOT} (sub-agent Bash context lacks plugin env vars).
- spawn prompt template (text the lead sends to the Bridge agent):

    Run this exact Bash command and return stdout verbatim:

    cd "C:/Users/tempe/.claude/plugins/marketplaces/trib-plugin/external_plugins/trib-plugin" && node ask.mjs :bridge_<role>_<shortHash> --preset <name> <<'TASKEOF'
    <task body for the external model>
    TASKEOF

    Set description to "trib-agent ask". Then SendMessage the stdout to lead.

- The explicit session id keeps each Bridge call in its own room — never mixed with the user's interactive ask sessions.
- External LLM round-trip takes 5-30s. Don't conclude "failed" on early idle notifications; wait for the SendMessage report.

## Message discipline

When you send a worker a **stand-down** message and then immediately receive approval for new work, do NOT just send the new task — messages can arrive out of order and the worker will treat them as contradictory. The new-task message must **explicitly retract** the stand-down, for example:

> Previous stand-down retracted. Proceed with Task #N.

Include the new spec in the same message. Without this retraction the worker will block on the conflict and ask for clarification, costing a full round-trip.

## Lead duties
- Read-verify every worker output. Never execute task work directly.

Old session teams are disposable. No manual cleanup required — they can be periodically pruned from `~/.claude/teams/`.

Quick questions: /ask (ask-forwarder).
