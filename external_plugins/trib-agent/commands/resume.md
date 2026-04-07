---
description: List sessions or set the active orchestrator session
argument-hint: "[sessionId|index]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" resume $ARGUMENTS`

Present the full output to the user. Do not summarize.
