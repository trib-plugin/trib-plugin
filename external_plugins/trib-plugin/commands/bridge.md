---
description: Bridge to external model. Usage /bridge <scope> <prompt>
argument-hint: "<scope> <prompt>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bridge" $ARGUMENTS`
