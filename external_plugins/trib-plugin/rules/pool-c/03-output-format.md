## Output format conventions

### JSON output
- When asked for JSON, return JSON only — no surrounding prose, no markdown fence is required (the parser handles both).
- Use double quotes for strings. No trailing commas. No comments.
- `id` and timestamp fields are integers, not strings.
- Empty arrays are `[]`, not `null`.
- If the task spec defines required fields, include all of them even when empty (`""` for strings, `[]` for arrays).

### Markdown output
- Use bullets (`-`) over prose where the spec allows.
- Headings only when the spec requests structure.
- No emoji. No decorative separators.
- Code identifiers (file paths, function names, table columns) wrap with backticks.

### Numeric / time conventions
- Timestamps in ms epoch are integers.
- Time strings use `YYYY-MM-DD HH:MM` (KST assumed unless specified otherwise).
- IDs verbatim — do not invent, normalize, or zero-pad.

### Language
- Match the language of the input data, not the system prompt.
- Korean entries → Korean output. English entries → English output. Mixed → dominant language.
- Technical identifiers (paths, API names, version numbers) stay in their original form regardless of output language.
