---
description: Ask the active orchestrator session (auto-creates from default preset if none)
argument-hint: "[--bg] [--context \"text\"] [:sessionId] <prompt>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" ask $ARGUMENTS`

Present the full output to the user. Do not summarize or condense it.
