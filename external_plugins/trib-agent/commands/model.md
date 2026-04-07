---
description: List presets or change the default preset
argument-hint: "[name|index]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" model $ARGUMENTS`

Present the full output to the user. Do not summarize.
