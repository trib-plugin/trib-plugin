---
description: Ask the trib-agent orchestrator (auto-creates a session from the default preset if none is active)
argument-hint: "<prompt>"
allowed-tools: Agent
---

Route this request to the `trib-plugin:ask-forwarder` subagent using the Agent tool.

Spawn the subagent with the CLI command baked into the prompt:

```
Agent({
  subagent_type: "trib-plugin:ask-forwarder",
  description: "trib-agent ask",
  prompt: "Run this exact Bash command and return stdout verbatim:\n\nCLAUDE_PLUGIN_DATA=\"${CLAUDE_PLUGIN_DATA}\" node \"${CLAUDE_PLUGIN_ROOT}/src/agent/orchestrator/cli.js\" ask \"<USER_PROMPT>\" 2>/dev/null"
})
```

Replace `<USER_PROMPT>` with the user's actual request below. Escape any double quotes in the prompt.

User request: $ARGUMENTS

Rules:
- Return the subagent's output verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary.
- If the user did not supply a prompt, tell them to provide one.
