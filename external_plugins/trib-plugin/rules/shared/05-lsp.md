# Code Symbols (LSP)

- For precise symbol lookup in TypeScript / JavaScript — resolving a function / class / method / variable to its canonical definition, or enumerating its real call sites — prefer the LSP-backed tools over `grep` or `explore`:
  - `mcp__plugin_trib-plugin_trib-plugin__lsp_definition({ symbol, file })` — one or more `path:line:col` definition locations.
  - `mcp__plugin_trib-plugin_trib-plugin__lsp_references({ symbol, file })` — every real call site / reference (scope-aware, shadowing-aware; unrelated same-named identifiers are excluded).
  - `mcp__plugin_trib-plugin_trib-plugin__lsp_symbols({ file })` — hierarchical outline of a file's classes / functions / methods / variables.
- `file` is a cwd-relative or absolute path to any TS/JS/MJS/CJS/TSX/JSX source that *contains or imports* the symbol; the typescript-language-server anchors its semantic analysis from that document. Both `symbol` and `file` are required for definition / references.
- Prefer LSP over `grep` whenever the symbol appears in more than one place (common method names like `get`, generic variable names, re-exported types in a barrel file). `grep` returns every textual match including comments and strings; LSP returns THE definition and only the genuine references.
- Not a replacement for `explore` (conceptual / multi-angle codebase search), `recall` (past decisions), `search` (external web), or direct `Read` (known file path).
- Language support: TypeScript / JavaScript only (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`). For other languages fall back to `explore` / `grep`.
- First call in a session pays a ~500 ms server-spawn + file-open cost; subsequent calls on the same workspace are tens of milliseconds. The server is torn down after 90 s of idle.
