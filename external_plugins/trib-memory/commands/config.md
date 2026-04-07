---
description: Open trib-memory settings
disable-model-invocation: true
allowed-tools:
  - Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/setup/setup-server.mjs" &`

Present the output verbatim. The setup UI should open in a browser window — if not, visit http://localhost:3457 manually.
