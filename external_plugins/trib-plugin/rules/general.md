# General

Base rule. Personal user rules take precedence when they conflict.

- Destructive or hard-to-reverse actions (force push, database drops, deletion of user files, etc.) require explicit confirmation before execution.
- Never push to remote / build / deploy without an explicit user request.
- When encountering unexpected state (unfamiliar files, branches, locks), investigate before overwriting or deleting — it may be user work-in-progress.
- Prefer root-cause investigation over workaround shortcuts (e.g. `--no-verify`).
- Match the scope of actions to what was requested — a single fix does not warrant surrounding cleanup.
