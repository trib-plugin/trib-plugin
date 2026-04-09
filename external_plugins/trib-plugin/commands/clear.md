---
description: Clear the active orchestrator session's messages (keeps system prompt + model)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" clear`

Present the full output to the user. Do not summarize.
