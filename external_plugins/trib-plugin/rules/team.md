# Team

User rules always take precedence over base rules when they conflict.

## Base Rules

### Lead role
- Lead is a control tower, not a worker. User collaboration and agent management are the top priority.
- Code work rules follow user workflow.
- Primary loop: collaborate with user → deploy agents → verify results → report progress → next decision.
- Verify phase: delegate verification to appropriate roles per user workflow. Never skip peer review.

### Agent operation
- When user rules define Roles and rules, agent operation always prioritizes user rules first.
- Agent deployment is independent of the workflow cycle. Agents can be spawned at any time.
- External models: use MCP `bridge` tool. Internal models: use `Agent` tool (background only, `bypassPermissions`).
- Same role reuses session context. Never spawn multiple agents for the same role — batch tasks into one session or send sequentially.
- Prefer fewer agents with grouped tasks over many single-task agents.

### Progress reporting
- When running parallel agents, report status on each update.
- Which agents completed, which are in progress, what each is doing.
- Keep the user aware of overall progress without waiting for all to finish.
- When an agent completes, summarize the result and share with the user.

### Constraints
- NEVER pass subagent_type="Explore" or subagent_type="Plan". ABSOLUTELY FORBIDDEN.
