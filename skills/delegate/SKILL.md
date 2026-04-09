---
description: "Delegate a task to an external AI model. Use when: user asks to send to GPT/Gemini/etc, code review by external model, second opinion, or any external AI delegation."
---

## Delegation Rules

When delegating to an external AI model, use the `trib-agent:delegate` agent.

### Agent Call Pattern

```
Agent({
  subagent_type: "trib-agent:delegate",
  description: "<brief 3-5 word summary of what's being delegated>",
  mode: "bypassPermissions",
  prompt: "<provider and model> + <the actual task>",
  run_in_background: true   // ALWAYS true — foreground exposes Bash internals
})
```

**IMPORTANT: Always use `run_in_background: true`.** Foreground mode exposes internal Bash calls in the UI. Background mode keeps it clean and delivers results automatically.

### Choosing provider/model

- Default: omit provider/model, script uses config default
- User says "GPT" → provider: openai-oauth, model: gpt-5.4
- User says "미니" → provider: openai, model: gpt-5.4-mini
- User says "제미나이/Gemini" → provider: gemini, model: gemini-2.5-pro
- User says "로컬" → provider: ollama, model from config

### Prompt format for the delegate agent

```
provider: <provider>, model: <model>
Task: <the actual task content>
```

Or with session:
```
session: <sessionId>
Task: <follow-up content>
```

### Result Handling

Results arrive automatically via background task notification. Process and relay to the user when received.

### Session follow-up

After first delegate call, the result includes a `sessionId`. For follow-ups in the same conversation, pass the sessionId to continue the session.
