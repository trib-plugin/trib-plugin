# Code Symbols (LSP)

Precise symbol lookup in TypeScript / JavaScript. Use LSP tools over `grep` / `explore` when resolving a function / class / method / variable to its canonical definition or enumerating real call sites:

- `lsp_definition({ symbol, file })` — one or more `path:line:col` definition locations.
- `lsp_references({ symbol, file })` — every genuine call site (scope-aware, shadowing-aware; unrelated same-named identifiers excluded).
- `lsp_symbols({ file })` — hierarchical outline of classes / functions / methods / variables.

`file` is any TS/JS source that *contains or imports* the symbol — the typescript-language-server anchors semantic analysis from that document. Both `symbol` and `file` required for definition / references.

Prefer LSP over `grep` whenever the symbol appears in multiple places (common method names like `get`, generic variable names, re-exported types in barrel files). `grep` matches comments / strings; LSP returns THE definition and only genuine references.

Not a replacement for `explore` (multi-angle codebase search), `recall` (past decisions), `search` (external web), or `Read` (known path).

Language: TS/JS only (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`). Other languages → fall back to `explore` / `grep`.

First call costs ~500 ms server-spawn + file-open; subsequent calls on same workspace are tens of ms. Server torn down after 90 s idle.
