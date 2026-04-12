---
description: Ask the trib-agent orchestrator (auto-creates a session from the default preset if none is active)
argument-hint: "<prompt>"
context: fork
allowed-tools: Bash(node:*)
---

Run this Bash command and return stdout verbatim — no paraphrasing, no commentary:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bridge-ask.mjs" ask <<'ASKEOF'
$ARGUMENTS
ASKEOF
```

Set `description: "trib-agent ask"` on the Bash call.

If the user did not supply a prompt, tell them to provide one.
If the command fails, say "ask failed" and nothing else.
