---
name: execute
description: A work plan has been approved and implementation needs to begin.
---

## Steps

1. **TeamCreate** — Create worker team

2. **TaskCreate** — Split plan into tasks
   - By scope, not by file
   - e.g. "Add API endpoint" / "Update frontend component"

3. **Task Loop** (repeat per task)
   - TaskUpdate(in_progress)
   - Assign Agent (Agent-a, b, c, d)
     - Independent work → multiple Agents in one message (parallel)
     - Dependent work → sequential
   - Agent prompt must include:
     - Goal (what and why)
     - Target file paths
     - Constraints
     - Completion criteria

4. **Worker completion** → proceed to /verify
