---
description: Ask an external model. Usage /ask <scope> <prompt>
argument-hint: "<scope> <prompt>"
context: fork
allowed-tools: Bash(node:*)
---

Run this Bash command and return stdout verbatim — no paraphrasing, no commentary:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ask" $ARGUMENTS
```

Set `description: "ask"` on the Bash call.

If the user did not supply scope and prompt, tell them: `Usage: /ask <scope> <prompt>`
If the command fails, say "ask failed" and show stderr.
