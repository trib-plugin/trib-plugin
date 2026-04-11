---
name: trib-execute
description: "This skill should be used when the user approves a plan and says 'let's go', 'implement it', 'start building', or gives go-ahead after planning."
---

## Process

1. **Declare the Agent plan BEFORE any TaskCreate.** For every upcoming task, explicitly state which Agent (Agent-a / Agent-b / Agent-c / Agent-d) handles it and with which preset. If the declaration is empty, the team system is pointless — STOP and rethink.
2. **Map dependencies and right-size parallelism.** Identify the dependency graph (independent vs serial chains). Parallelization has real cost — context duplication, coordination overhead, cross-worker inconsistency. Split into multiple workers only when tasks are genuinely heavy, contexts truly differ, or critical-path speedup matters. Many uniform small edits in a shared context → single worker.
3. **TeamCreate.**
4. **TaskCreate** — one task = one meaningful change unit. Don't shatter a unified change into per-file tasks just because it touches multiple files. If one worker can hold the shared context and apply the pattern consistently, that's one task — not six. Split by scope, not by file count.
5. **Task loop**
   - TaskUpdate(in_progress)
   - `/assign` with the task's declared preset (worker → Claude, bridge → external model). **Independent tasks MUST run in a single message with multiple `/assign` calls (parallel).** Serial only when later tasks truly depend on earlier results.
   - Agent prompt must be self-contained (goal, target file paths, constraints, completion criteria) AND MUST mandate a result-report message on completion. An idle-only return is treated as incomplete — the lead Read-verifies the outcome and never assumes done.
   - After each agent completes, the lead Read-verifies before marking done.

> **Hard rule.** The team-lead MUST NOT execute task content directly. Only trivial single-line bash, stash/backup, or git status checks are allowed. If you catch yourself writing implementation code, STOP and `/assign` instead. Team system without `/assign` is an empty shell.

When all workers complete → proceed to the Verify phase.
