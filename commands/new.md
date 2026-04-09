---
description: Create a new orchestrator session with the default preset (becomes active)
argument-hint: "[prompt]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/external_plugins/trib-plugin/src/agent/orchestrator/cli.js" new $ARGUMENTS`

Present the full output to the user. Do not summarize.
