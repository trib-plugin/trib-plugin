#!/usr/bin/env node
// Short wrapper: `node ask.mjs "prompt"` → `cli.js ask "prompt"`
process.argv = [process.argv[0], process.argv[1], 'ask', ...process.argv.slice(2)];
await import('./src/agent/orchestrator/cli.mjs');
