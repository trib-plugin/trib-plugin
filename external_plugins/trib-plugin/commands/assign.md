---
description: Assign a task to an agent using a model preset
argument-hint: "<preset> <prompt>"
---

Parse the arguments: first word is the preset ID, rest is the prompt.

Look up the preset from the injected Models context (the "Available presets" list in the system prompt).
If the Models context is missing, read presets directly from `${CLAUDE_PLUGIN_DATA}/agent-config.json`.

Routing by preset type:
- **worker** → spawn Agent with `subagent_type: "Worker"`, set `model` to the preset's model (opus/sonnet/haiku)
- **bridge** → spawn Agent with `subagent_type: "Bridge"`, include `--preset <id>` in the prompt
- **not found** → warn user, list available presets, fall back to current model as Worker

Spawn the agent with:
- run_in_background: true
- mode: bypassPermissions
- team_name: current team (if in a team)

Report to user: which preset/model was used and that the agent was assigned.
