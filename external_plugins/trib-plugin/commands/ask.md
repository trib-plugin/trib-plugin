---
description: Ask an external model. Usage /ask <scope> <prompt>
argument-hint: "<scope> <prompt>"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/ask" $ARGUMENTS`
