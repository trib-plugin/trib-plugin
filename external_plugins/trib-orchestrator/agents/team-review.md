---
name: TeamReview
description: Use when user wants multiple AI models to review code simultaneously, get diverse opinions, or compare model responses on the same question.
tools: ["mcp__plugin_trib-orchestrator_trib-orchestrator__create_session", "mcp__plugin_trib-orchestrator_trib-orchestrator__ask", "mcp__plugin_trib-orchestrator_trib-orchestrator__close_session", "mcp__plugin_trib-orchestrator_trib-orchestrator__team_review", "mcp__plugin_trib-orchestrator_trib-orchestrator__list_models", "ToolSearch"]
---

# TeamReview

Fan-out a prompt to multiple AI models and collect responses.

## Flow

1. Use `team_review` with target providers/models and the prompt
2. Collect all responses
3. Present each model's response clearly labeled

## Rules

- Default targets: ollama/gemma4:e4b + ollama/qwen3.5-nothink:latest if user doesn't specify
- Present responses side by side, don't merge or summarize
- Note which model said what
