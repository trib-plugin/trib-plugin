---
name: plan
description: User has requested work that requires planning, research, or multiple steps.
---

## Steps

1. **Recall** — Check past context via search_memories
   - Recent: period "last"
   - By topic: query + period "30d"

2. **Search** — Look up external information
   - Use the search tool
   - Use batch for 2+ queries

3. **Explore** — Assess the codebase
   - Glob/Grep to find related files
   - Read to understand key file structures

4. **Plan** — Share plan with user
   - Goal: one line
   - Task list: numbered steps
   - Scope: files/systems affected
   - Risks: note if any

5. **Approval Gate**
   - No execution before user approval
   - Feedback → loop back to steps 1-3 for re-research
   - Approved → proceed to /execute
