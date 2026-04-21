import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { pushDispatchResult } from '../src/agent/orchestrator/ai-wrapped-dispatch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// ── 1. pushDispatchResult swallows async notify rejection ───────────────────
{
  let unhandled = null;
  const onUnhandled = (reason) => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  try {
    pushDispatchResult(
      { notifyFn: () => Promise.reject(new Error('notify boom')) },
      'dispatch_search_async_fail',
      'search',
      ['q'],
      'body',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(unhandled === null, 'pushDispatchResult: rejected notify promise does not leak as unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

// ── 2. /bridge HTTP route preserves notify metadata ─────────────────────────
{
  const channelsSrc = readFileSync(join(PLUGIN_ROOT, 'src/channels/index.mjs'), 'utf8');
  assert(
    /const notifyFn = \(text, extraMeta\) => \{/.test(channelsSrc),
    'channels/index.mjs: /bridge route notifyFn accepts extraMeta',
  );
  assert(
    /\.\.\.\(extraMeta \|\| \{\}\)/.test(channelsSrc),
    'channels/index.mjs: /bridge route merges extraMeta into notification meta',
  );
}

// ── 3. Detached bridge runner has a terminal catch guard ────────────────────
{
  const agentSrc = readFileSync(join(PLUGIN_ROOT, 'src/agent/index.mjs'), 'utf8');
  assert(
    /\}\)\(\)\.catch\(\(err\) => \{/.test(agentSrc),
    'agent/index.mjs: detached bridge runner has a terminal .catch guard',
  );
  assert(
    /detached runner unhandled/.test(agentSrc),
    'agent/index.mjs: detached bridge runner writes an explicit crash log',
  );
}

console.log(`PASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
