---
description: Ask the trib-agent orchestrator (auto-creates a session from the default preset if none is active)
argument-hint: "<prompt>"
allowed-tools: Agent
---

Route this request to the `trib-plugin:ask-forwarder` subagent using the Agent tool.

Raw user request:
$ARGUMENTS

Execution:

Spawn the subagent like this:

```
Agent({
  subagent_type: "trib-plugin:ask-forwarder",
  description: "trib-agent ask",
  prompt: "<the user's raw prompt text>"
})
```

Rules:
- Return the subagent's output verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect files, monitor progress, or do follow-up work of its own.
- If the user did not supply a prompt, tell them to provide one.
