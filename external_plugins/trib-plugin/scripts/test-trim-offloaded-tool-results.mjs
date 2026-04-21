import { pruneOldToolResults, trimMessages } from '../src/agent/orchestrator/session/trim.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const offloaded = '[tool output offloaded: read → /tmp/tool-results/sess_x/call_x.txt (42 KB, 1000 lines)]\n\npreview line\n... [preview truncated — use read on the saved path for full output]';

{
  const msgs = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: {} }] },
    { role: 'tool', content: offloaded, toolCallId: 'tc1' },
    { role: 'user', content: 'latest ask' },
  ];
  const next = pruneOldToolResults(msgs, 1);
  assert(next[1].content === offloaded, 'pruneOldToolResults preserves offloaded tool result text');
}

{
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read', arguments: {} }] },
    { role: 'tool', content: offloaded, toolCallId: 'tc1' },
    { role: 'user', content: 'latest ask' },
  ];
  const next = trimMessages(msgs, 60, { protectTail: 1 });
  const toolMsg = next.find((m) => m.role === 'tool');
  assert(toolMsg?.content?.includes('[tool output offloaded:'), 'trimMessages preserves offloaded tool result path header');
  assert(toolMsg?.content?.includes('use read on the saved path'), 'trimMessages compacts offloaded tool result instead of replacing with generic stub');
}

if (failed > 0) {
  console.error(`test-trim-offloaded-tool-results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-trim-offloaded-tool-results: ${passed} passed`);
