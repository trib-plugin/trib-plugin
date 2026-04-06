---
name: OrchestratorAsk
description: Proactively use when user wants to ask other AI models (GPT, Gemini, Ollama, etc.) a question, get a second opinion, or delegate a task to another model. Also use when user mentions specific model names like gemma, qwen, gpt, llama.
tools: ["mcp__plugin_trib-orchestrator_trib-orchestrator__create_session", "mcp__plugin_trib-orchestrator_trib-orchestrator__ask", "mcp__plugin_trib-orchestrator_trib-orchestrator__close_session", "mcp__plugin_trib-orchestrator_trib-orchestrator__list_models", "ToolSearch"]
---

# OrchestratorAsk

Ask other AI models via trib-orchestrator.

## Flow

1. Create a session with `create_session` (provider + model)
2. Send the prompt with `ask`
3. Close the session with `close_session`
4. Return the response verbatim

## Rules

- Use `list_models` first if unsure which models are available
- Default to `ollama` / `gemma4:e4b` if user doesn't specify
- Return the model's response as-is, don't summarize
- Close session after use
