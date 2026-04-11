# Team

Use ONE fixed team name (e.g., main) for the entire project lifecycle. TeamCreate happens once on first use; afterwards just add tasks.

Real coding/file-modification work runs through this team. Trivial single-step lookups (file search, function search, quick test) can use a one-off background Agent without joining the team.

Setup
- TaskCreate (one meaningful unit each).
- Spawn sub-agent the first time via Agent tool: subagent_type Worker (opus/sonnet/haiku) or Bridge (external preset). run_in_background=true, team_name=current.
- Do NOT use built-in Explore or Plan subagent types — always Worker/Bridge.
- Pick presets from the Models section in the system prompt (auto-injected from agent-config.json). See User Workflow below for role→preset mapping.

Reuse and replacement
- Reuse the same Agent (Agent-a) by SendMessage with the new task content. Do NOT respawn under the same name — that creates Agent-a-2.
- Switch to Agent-b/c/d only when context overflows or the task is completely unrelated.

Bridge spawn pattern
- Treat Bridge agents as thin pipes. The Bridge runs on haiku and only forwards.
- ALWAYS embed an explicit session id in the Bash command so the Bridge call does NOT inherit the user's active session. Naming convention: `:bridge_<agentName>_<shortHash>`.
- Use absolute marketplace path; do NOT use ${CLAUDE_PLUGIN_ROOT} (sub-agent Bash context lacks plugin env vars).
- spawn prompt template (text the lead sends to the Bridge agent):

    Run this exact Bash command and return stdout verbatim:

    cd "C:/Users/tempe/.claude/plugins/marketplaces/trib-plugin/external_plugins/trib-plugin" && node ask.mjs :bridge_<agentName>_<shortHash> --preset <name> <<'TASKEOF'
    <task body for the external model>
    TASKEOF

    Set description to "trib-agent ask". Then SendMessage the stdout to lead.

- The explicit session id keeps each Bridge call in its own room — never mixed with the user's interactive ask sessions.
- External LLM round-trip takes 5-30s. Don't conclude "failed" on early idle notifications; wait for the SendMessage report.

Lead duties
- Read-verify every worker output. Never execute task work directly.

No TeamDelete in routine retro — keep the team alive across sessions for continuity. Only delete when user explicitly winds the project down.

Quick questions: /ask (ask-forwarder).
