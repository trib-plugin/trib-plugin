---
description: Ask the trib-agent orchestrator (auto-creates a session from the default preset if none is active)
argument-hint: "<prompt>"
context: fork
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Route this request to the `ask-forwarder` subagent.
The final user-visible response must be the orchestrator's output verbatim.

Raw user request:
$ARGUMENTS

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/src/agent/orchestrator/cli.js" ask` with the raw user prompt and return that command's stdout as-is.
- Return the orchestrator stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect files, monitor progress, or do follow-up work of its own.
- If the user did not supply a prompt, tell them to provide one.
