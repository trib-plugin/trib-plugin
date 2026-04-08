---
description: Open trib-memory settings
disable-model-invocation: true
allowed-tools:
  - Bash(node:*)
---

!`echo "Config UI: http://localhost:3457" && nohup node "${CLAUDE_PLUGIN_ROOT}/setup/setup-server.mjs" > /dev/null 2>&1 &`
