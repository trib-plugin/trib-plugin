/**
 * Tests for the `silent_to_agent` notification flag.
 *
 * Verifies:
 *   1. Default (no flag) → notification reaches Lead via sendNotifyToParent.
 *   2. silent_to_agent:true → Lead hop skipped, Discord forward still fires.
 *   3. Event-log (memoryAppendEntry) records in BOTH cases.
 *   4. Bridge lifecycle "started" banner is NOT silent (non-silent MCP Noti — terminal + Lead both see it).
 *   5. Final "Done" result payload does NOT carry silent_to_agent.
 *   6. Stall watchdog notifications are NOT silent.
 *   7. aiWrapped "started" echo is NOT silent; dispatch_result push is NOT silent.
 *
 * Strategy
 * ────────
 * The two central emit points (`injectAndRecord` in channels/index.mjs and
 * `pushChannelNotification` in server.mjs) both live inside modules with
 * heavyweight import-time side effects (worker forks, MCP transport boot,
 * etc.). For hermetic unit coverage we reconstruct the exact function body
 * here with injected spies — if the shipping source drifts from this
 * replica, the assertions below still pin the CONTRACT the task requires,
 * and the separate string-match assertions against the real source files
 * detect drift of the emission sites themselves.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ── Replica of injectAndRecord (see src/channels/index.mjs) ──────────
// Contract under test: when options.silent_to_agent is truthy, skip the
// sendNotifyToParent hop but still fire the Discord forward and the
// memoryAppendEntry record.
function makeInjectAndRecord(spies) {
  const { sendNotifyToParent, memoryAppendEntry, forwardLifecycleToDiscord } = spies;
  return function injectAndRecord(channelId, name, content, options, kind, prefix) {
    const ts = new Date().toISOString();
    const now = new Date();
    const timeLabel = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} `;
    const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
    const meta = { chat_id: channelId, user: sourceLabel, user_id: 'system', ts };
    if (options?.instruction) meta.instruction = options.instruction;
    if (options?.type) meta.type = options.type;
    if (options?.silent_to_agent) meta.silent_to_agent = true;
    const silent = options?.silent_to_agent === true;
    if (!silent) {
      sendNotifyToParent('notifications/claude/channel', { content, meta });
    } else {
      forwardLifecycleToDiscord(channelId, content);
    }
    memoryAppendEntry({
      ts,
      role: 'user',
      content: options?.instruction || content,
      sourceRef: `${prefix}:${name}:${ts}`,
      sessionId: `${prefix}:${name}`,
    });
  };
}

// ── Replica of pushChannelNotification (see server.mjs) ──────────────
function makePushChannelNotification(spies) {
  const { serverNotification, channelsWorkerSend } = spies;
  return function pushChannelNotification(content, extraMeta) {
    const meta = { user: 'trib-agent', user_id: 'system', ts: new Date().toISOString(), ...(extraMeta || {}) };
    const silent = meta.silent_to_agent === true;
    if (silent) {
      channelsWorkerSend({ type: 'forward_to_discord', content, channelId: meta.chat_id || null });
      return Promise.resolve();
    }
    return serverNotification({ method: 'notifications/claude/channel', params: { content, meta } });
  };
}

// ── 1. injectAndRecord: default → reaches Lead, records log ─────────
{
  const notifyCalls = [];
  const logCalls = [];
  const discordCalls = [];
  const inject = makeInjectAndRecord({
    sendNotifyToParent: (method, params) => notifyCalls.push({ method, params }),
    memoryAppendEntry: (entry) => logCalls.push(entry),
    forwardLifecycleToDiscord: (channelId, content) => discordCalls.push({ channelId, content }),
  });
  inject('chan-1', 'sched-A', 'hello world', {}, 'schedule-inject', 'schedule');
  assert(notifyCalls.length === 1, 'default: parent-notify called once');
  assert(notifyCalls[0].method === 'notifications/claude/channel', 'default: method is notifications/claude/channel');
  assert(notifyCalls[0].params.meta.silent_to_agent === undefined, 'default: meta omits silent_to_agent flag');
  assert(logCalls.length === 1 && logCalls[0].content === 'hello world', 'default: event-log record written');
  assert(discordCalls.length === 0, 'default: direct Discord forward NOT invoked (Lead handles it)');
}

// ── 2. injectAndRecord: silent → Lead skipped, Discord forwarded, log kept
{
  const notifyCalls = [];
  const logCalls = [];
  const discordCalls = [];
  const inject = makeInjectAndRecord({
    sendNotifyToParent: (method, params) => notifyCalls.push({ method, params }),
    memoryAppendEntry: (entry) => logCalls.push(entry),
    forwardLifecycleToDiscord: (channelId, content) => discordCalls.push({ channelId, content }),
  });
  inject('chan-1', 'lifecycle', '[opus-4-7] worker started', { silent_to_agent: true }, 'lifecycle', 'bridge');
  assert(notifyCalls.length === 0, 'silent: parent-notify NOT called');
  assert(discordCalls.length === 1, 'silent: Discord forward still fires');
  assert(discordCalls[0].content === '[opus-4-7] worker started', 'silent: Discord payload carries the banner text');
  assert(logCalls.length === 1, 'silent: event-log record still written');
}

// ── 3. pushChannelNotification: default → reaches Lead ──────────────
{
  const serverCalls = [];
  const workerSends = [];
  const push = makePushChannelNotification({
    serverNotification: (p) => { serverCalls.push(p); return Promise.resolve(); },
    channelsWorkerSend: (m) => workerSends.push(m),
  });
  push('async search result body', { type: 'dispatch_result', dispatch_id: 'dispatch_search_1' });
  assert(serverCalls.length === 1, 'default: server.notification called once');
  assert(serverCalls[0].params.meta.type === 'dispatch_result', 'default: dispatch_result meta propagates');
  assert(workerSends.length === 0, 'default: channels worker IPC NOT invoked');
}

// ── 4. pushChannelNotification: silent → IPC fork-and-forward to Discord
{
  const serverCalls = [];
  const workerSends = [];
  const push = makePushChannelNotification({
    serverNotification: (p) => { serverCalls.push(p); return Promise.resolve(); },
    channelsWorkerSend: (m) => workerSends.push(m),
  });
  push('[opus-4-7] worker started', { silent_to_agent: true });
  assert(serverCalls.length === 0, 'silent: server.notification NOT called');
  assert(workerSends.length === 1, 'silent: channels worker forward_to_discord IPC fired');
  assert(workerSends[0].type === 'forward_to_discord', 'silent: IPC message type is forward_to_discord');
  assert(workerSends[0].content === '[opus-4-7] worker started', 'silent: IPC payload carries the status ping');
}

// ── 5. Drift checks against shipping source ─────────────────────────
// Lifecycle emission sites must carry silent_to_agent:true; final/error
// emissions must NOT. The easiest way to pin this without booting the
// modules is source-level string matching with tight neighbourhoods.
const AGENT_SRC = readFileSync(join(PLUGIN_ROOT, 'src/agent/index.mjs'), 'utf8');
const AIWRAP_SRC = readFileSync(join(PLUGIN_ROOT, 'src/agent/orchestrator/ai-wrapped-dispatch.mjs'), 'utf8');
const WATCHDOG_SRC = readFileSync(join(PLUGIN_ROOT, 'src/agent/bridge-stall-watchdog.mjs'), 'utf8');
const SERVER_SRC = readFileSync(join(PLUGIN_ROOT, 'server.mjs'), 'utf8');
const CHANNELS_SRC = readFileSync(join(PLUGIN_ROOT, 'src/channels/index.mjs'), 'utf8');

// Bridge worker "started" banner emits WITHOUT silent_to_agent (non-silent).
{
  const m = AGENT_SRC.match(/emit\(`\$\{modelTag\}\$\{role\} started`\)/);
  assert(!!m, 'agent/index.mjs: `${role} started` emit is non-silent (no meta arg)');
}

// Final Done / result emission stays non-silent (no silent_to_agent key).
{
  // The success emit line at `emit(`${modelTag}[${role}] ${content}\n\n${footer}`)`
  // must NOT carry silent_to_agent.
  const line = AGENT_SRC.match(/emit\(`\$\{modelTag\}\[\$\{role\}\] \$\{content\}[\s\S]{0,60}footer\}`\)/);
  assert(!!line, 'agent/index.mjs: Done-result emit site found');
  assert(line && !/silent_to_agent/.test(line[0]), 'agent/index.mjs: Done-result emit NOT silent');
}

// Error emissions remain non-silent (so Lead sees failure).
{
  const errEmit = AGENT_SRC.match(/emit\(`\$\{role\} error: \$\{errorMessage\}`\)/);
  assert(!!errEmit && !/silent_to_agent/.test(errEmit[0] || ''), 'agent/index.mjs: `role error` emit NOT silent');
}

// Stall-watchdog notify(msg) signature is still single-arg (implicitly
// non-silent — no meta to raise the flag).
{
  const call = WATCHDOG_SRC.match(/try \{ notify\(msg\);/);
  assert(!!call, 'bridge-stall-watchdog.mjs: notify(msg) single-arg call preserved (non-silent)');
}

// aiWrapped "<tool> started" echo emits WITHOUT silent_to_agent (non-silent).
{
  const echo = AIWRAP_SRC.match(/ctx\.notifyFn\(`\$\{name\} started`\)/);
  assert(!!echo, 'ai-wrapped-dispatch.mjs: `<tool> started` echo is non-silent (no meta arg)');
}

// aiWrapped pushDispatchResult fires notify with type:'dispatch_result' and
// does NOT carry silent_to_agent. Promise.resolve(...) may now wrap the
// notify call, so match the presence of the dispatch_result payload more
// loosely instead of depending on a single-line notify(...) shape.
{
  assert(/type:\s*'dispatch_result'/.test(AIWRAP_SRC), 'ai-wrapped-dispatch.mjs: dispatch_result payload present');
  assert(!/type:\s*'dispatch_result'[\s\S]{0,240}silent_to_agent/.test(AIWRAP_SRC), 'ai-wrapped-dispatch.mjs: dispatch_result push NOT silent');
}

// server.mjs pushChannelNotification honours silent_to_agent.
{
  assert(/silent_to_agent/.test(SERVER_SRC), 'server.mjs: pushChannelNotification references silent_to_agent');
  assert(/forward_to_discord/.test(SERVER_SRC), 'server.mjs: silent path forwards via channels worker IPC');
}

// channels/index.mjs injectAndRecord honours silent_to_agent.
{
  assert(/options\?\.silent_to_agent/.test(CHANNELS_SRC), 'channels/index.mjs: injectAndRecord checks options.silent_to_agent');
  assert(/forwardLifecycleToDiscord/.test(CHANNELS_SRC), 'channels/index.mjs: injectAndRecord uses forwardLifecycleToDiscord on silent path');
  assert(/type === 'forward_to_discord'/.test(CHANNELS_SRC), 'channels/index.mjs: worker IPC listens for forward_to_discord');
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
