TOOL EFFICIENCY (mandatory):
1. Parallel first — independent calls in ONE message, not sequential turns.
2. Multi-angle = array — explore/recall/search/multi_read accept query/path arrays; never loop sequential calls.
3. Past first — recall before search, search before explore, explore before grep+read.
4. Batch edits — multi_edit (1 file, N changes) / batch_edit (N files); never serial edit.
5. No serial reads/greps — 2+ files = multi_read; 2+ patterns = grep array.
