#!/usr/bin/env node
/**
 * bridge-ask.mjs — Unified forwarding wrapper for Bridge and ask-forwarder.
 *
 * Usage (stdin):
 *   echo "prompt" | node bridge-ask.mjs <scope>
 *   echo "--preset GPT5.4\nprompt" | node bridge-ask.mjs <scope>
 *
 * scope = agent name (e.g. "reviewer", "debugger")
 *   - "ask" → --lane ask (user-facing, no --scope)
 *   - others → --lane bridge --scope <scope>
 *
 * stdin first line: if "--preset <name>", extracted as preset (default: GPT5.4)
 */

const scope = process.argv[2] || 'unknown';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input = Buffer.concat(chunks).toString('utf8').trim();

if (!input) {
    process.stderr.write('bridge-ask: no input on stdin\n');
    process.exit(1);
}

let preset = null;
const firstNewline = input.indexOf('\n');
const firstLine = firstNewline === -1 ? input : input.slice(0, firstNewline).trim();

if (firstLine.startsWith('--preset ')) {
    preset = firstLine.slice('--preset '.length).trim();
    input = firstNewline === -1 ? '' : input.slice(firstNewline + 1).trim();
}

if (!input) {
    process.stderr.write('bridge-ask: empty prompt after parsing\n');
    process.exit(1);
}

const lane = scope === 'ask' ? 'ask' : 'bridge';
const args = ['ask'];
if (preset) args.push('--preset', preset);
args.push('--lane', lane);
if (lane === 'bridge') args.push('--scope', scope);
args.push(input);

process.argv = [process.argv[0], process.argv[1], ...args];
await import('./src/agent/orchestrator/cli.mjs');
