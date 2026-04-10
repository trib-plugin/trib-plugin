---
description: Assign a task to an agent using a model preset
argument-hint: "<preset> <prompt>"
---

Parse the arguments: first word is the preset ID, rest is the prompt.

Look up the preset from the injected Models context:
- If preset type is "worker" → spawn a Worker agent with the preset's model and effort
- If preset type is "bridge" → spawn a Bridge agent, passing --preset to trib-agent
- If preset not found → warn user, list available presets, fall back to current Claude Code model as Worker

Spawn the agent with:
- run_in_background: true
- mode: bypassPermissions
- team_name: current team (if in a team)

Report to user: which preset/model was used and that the agent was assigned.
