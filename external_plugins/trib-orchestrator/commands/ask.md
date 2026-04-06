---
description: Ask a model via trib-orchestrator (internal)
user-invocable: false
disable-model-invocation: false
allowed-tools: Bash(node:*)
---

Parse `$ARGUMENTS` for provider, model, and prompt.
Format: `provider model prompt text`

!`node "${CLAUDE_PLUGIN_DATA}/cli.bundle.mjs" ask $ARGUMENTS`

Present the full output to the user. Do not summarize or condense it.
