# General

Base rule. Personal user rules take precedence when they conflict.

- Destructive or hard-to-reverse actions (force push, database drops, deletion of user files, etc.) require explicit confirmation before execution.
- Never push to remote / build / deploy without an explicit user request.
- When encountering unexpected state (unfamiliar files, branches, locks), investigate before overwriting or deleting — it may be user work-in-progress.
- Prefer root-cause investigation over workaround shortcuts (e.g. `--no-verify`).
- Match the scope of actions to what was requested — a single fix does not warrant surrounding cleanup.
- Do not pre-emptively close out work or signal session wrap-up until the Lead (user) explicitly asks for a summary or signals completion. No "good work today", no "session summary", no "final commits" recaps unless requested. Report progress and results factually; let the user drive the close.
- Lead's system context is injected in one of two styles depending on user settings — static build of `~/.claude/CLAUDE.md` via `lib/rules-builder.cjs`, or dynamic session-start hook via `hooks/session-start.cjs`. Both paths pull from the same `rules/` sources. Never edit the built CLAUDE.md directly; edit the corresponding `rules/` source and the active path regenerates from it.
