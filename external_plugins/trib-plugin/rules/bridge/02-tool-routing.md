# Tool Routing

Static preferences loaded once into the shared role catalog (BP2). Permission
is enforced at call time — if a write/shell tool is denied, report back
instead of looping. No need for per-role tool-routing snippets in BP3.

- Multi-file or already-clear edits: prefer `apply_patch` before repeated `read` → `edit`.
- Known file → `read` directly; unknown location → `grep` / `glob` first, then targeted `read`.
- Code structure questions (imports, dependents, symbols, references): prefer `code_graph` before raw `grep`.
- Shell work across turns: use `bash_session` to reuse shell state instead of replaying setup.
- Large tool outputs may be saved to a path with a preview; only `read` that saved path if the preview is insufficient.
