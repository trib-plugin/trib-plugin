---
description: Ask the trib-agent orchestrator (auto-creates a session from the default preset if none is active)
argument-hint: "<prompt>"
disable-model-invocation: true
allowed-tools: Agent
---

Spawn the ask-forwarder subagent in the background:

```
Agent({
  subagent_type: "trib-plugin:ask-forwarder",
  description: "trib-agent ask",
  run_in_background: true,
  prompt: "Run this Bash command and return stdout verbatim:\n\nCLAUDE_PLUGIN_DATA=\"${CLAUDE_PLUGIN_DATA}\" node \"${CLAUDE_PLUGIN_ROOT}/ask.mjs\" \"<USER_PROMPT>\" 2>/dev/null\n\nCRITICAL: Set description to \"trib-agent ask\" on the Bash call. Return ONLY stdout, no commentary."
})
```

Replace `<USER_PROMPT>` with the user's actual request below. Escape any double quotes.

User request: $ARGUMENTS

After spawning, tell the user the request was sent. When the background agent completes, relay its output verbatim — no paraphrasing, no commentary.

If the user did not supply a prompt, tell them to provide one.
