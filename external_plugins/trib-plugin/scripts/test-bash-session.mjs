/**
 * Tests for bash_session — persistent shell tool shipped in v0.6.224~233.
 *
 * Exercises the handler in src/agent/orchestrator/tools/bash-session.mjs
 * (registered via tools.json lines 1695-1730 as module:"bash_session").
 *
 * Coverage:
 *   1. New session — omit session_id, response header prints [session: <id>].
 *   2. State persistence — cwd + exported env survive across calls.
 *   3. close:true terminates the child; reusing the id mints a fresh shell.
 *   4. Destructive patterns refused (rm -rf /, git push --force).
 *   5. Timeout — short-timeout call kills the shell and surfaces marker.
 *   6. Max-10 pool — 11th unique session evicts the oldest idle entry.
 *   7. stderr separated — commands that write to both streams produce a
 *      [stderr] block in the response.
 *   8. Unknown session_id minted rather than erroring (stable resume).
 */

import { executeBashSessionTool, __getBashSessionStateForTesting } from '../src/agent/orchestrator/tools/bash-session.mjs';
import {
  executeBuiltinTool,
  invalidateBuiltinResultCache,
  resetBuiltinCacheStatsForTesting,
  getBuiltinCacheStatsForTesting,
} from '../src/agent/orchestrator/tools/builtin.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

async function run(args) {
  return executeBashSessionTool('bash_session', args);
}

function extractId(response) {
  const m = /\[session: (sess_[0-9a-f-]+)\]/.exec(response || '');
  return m ? m[1] : null;
}

// Track every session id we touch so we can hard-close at the end even if
// assertions bail mid-way. The module keeps its pool module-scoped, so the
// only public hook for cleanup is close:true.
const allIds = new Set();
function track(id) { if (id) allIds.add(id); }

async function closeAll() {
  for (const id of allIds) {
    try { await run({ session_id: id, command: 'true', close: true }); }
    catch { /* ignore */ }
  }
}

try {
  // ── 1. New session — header carries [session: <id>] ───────────────────
  {
    const res = await run({ command: 'echo hello' });
    const id = extractId(res);
    track(id);
    assert(!!id, `new session header contains [session: <id>] (got: ${JSON.stringify(res.slice(0, 80))})`);
    assert(/\bhello\b/.test(res), 'echo output present in body');
  }

  // ── 2. State persistence across calls ─────────────────────────────────
  {
    const first = await run({ command: 'cd /tmp && export FOO=bar && echo primed' });
    const id = extractId(first);
    track(id);
    assert(!!id, 'state-test session minted');
    const second = await run({ session_id: id, command: 'pwd && echo $FOO' });
    assert(extractId(second) === id, 'second call reuses same session id');
    assert(/\/tmp/.test(second), `cwd persisted across calls (got: ${JSON.stringify(second)})`);
    assert(/\bbar\b/.test(second), `exported $FOO persisted across calls (got: ${JSON.stringify(second)})`);
  }

  // ── 2b. Actual shell cwd is re-synced even after a failing command ─────
  {
    const first = await run({ command: 'cd /tmp && false' });
    const id = extractId(first);
    track(id);
    assert(!!id, 'cwd-sync session minted');
    const state = __getBashSessionStateForTesting(id);
    assert(state && /\/tmp/.test(String(state.cwd || '')), `cwd sync updates stored cwd after failing command (got: ${JSON.stringify(state)})`);
    const second = await run({ session_id: id, command: 'pwd' });
    assert(/\/tmp/.test(second), `pwd reflects synced cwd after failing command (got: ${JSON.stringify(second)})`);
  }

  // ── 3. close:true terminates; reusing id mints fresh shell ───────────
  {
    const a = await run({ command: 'export MARKER=one && echo a' });
    const id = extractId(a);
    track(id);
    assert(!!id, 'close-test session minted');
    const b = await run({ session_id: id, command: 'echo closing', close: true });
    assert(/\[closed\]/.test(b), 'close:true emits [closed] marker in header');
    // Reuse the same id — stable-resume semantics mint a new shell, so the
    // previous $MARKER export should be gone.
    const c = await run({ session_id: id, command: 'echo "m=${MARKER:-unset}"' });
    track(extractId(c));
    assert(/m=unset/.test(c), `reusing closed id mints a fresh shell (got: ${JSON.stringify(c)})`);
  }

  // ── 4. Destructive pattern refused ───────────────────────────────────
  {
    const r1 = await run({ command: 'rm -rf /' });
    assert(/blocked command pattern/i.test(r1), `rm -rf / refused (got: ${JSON.stringify(r1)})`);
    const r2 = await run({ command: 'git push --force origin main' });
    assert(/blocked command pattern/i.test(r2), `git push --force refused (got: ${JSON.stringify(r2)})`);
    // Neither blocked call should spawn a shell — no session id in output.
    assert(!extractId(r1), 'blocked call does not mint a session');
  }

  // ── 5. Timeout — command exceeding per-call timeout is killed ────────
  {
    // timeout: 2 → interpreted as 2 seconds by the handler (values ≤ 600
    // taken as seconds). `sleep 10` far exceeds that; handler kills the
    // shell and returns a timeout marker.
    const t0 = Date.now();
    const r = await run({ command: 'sleep 10', timeout: 2 });
    const elapsed = Date.now() - t0;
    const id = extractId(r);
    track(id);
    assert(/\[timeout: \d+ ms — session killed\]/.test(r), `timeout marker present (got: ${JSON.stringify(r)})`);
    assert(elapsed < 5000, `timeout fired well before sleep completed (${elapsed} ms)`);
    // After timeout the shell was SIGTERM'd. Per the handler contract the
    // caller must mint a NEW session (no session_id) — the old child may
    // still be draining its exit, so reusing the id races the exit handler.
    const r2 = await run({ command: 'echo alive' });
    track(extractId(r2));
    assert(/\balive\b/.test(r2), 'caller mints a new session after timeout kill and it runs cleanly');
  }

  // ── 6. Pool cap (MAX_SESSIONS=10) — 11th spawn evicts oldest idle ────
  {
    // Spawn 10 fresh sessions with a distinguishing env var each. Order
    // matters: slot0 is created first → has the smallest lastUsed →
    // becomes the eviction target when slot 11 arrives.
    const poolIds = [];
    for (let i = 0; i < 10; i++) {
      const r = await run({ command: `export POOL_TAG=slot${i} && echo ok` });
      const id = extractId(r);
      track(id);
      poolIds.push(id);
    }
    // Spawn the 11th — this must evict the oldest idle entry (slot0).
    // Close it immediately after so it doesn't crowd out survivors when
    // we probe them below (each unknown-id probe spawns, which would
    // re-trigger eviction and confuse the assertion).
    const r11 = await run({ command: 'export POOL_TAG=slot10 && echo ok', close: true });
    track(extractId(r11));
    // Probe a non-evicted survivor FIRST — slot1 is still in the pool so
    // this is a reuse (no spawn, no eviction side-effect).
    const survivor = await run({ session_id: poolIds[1], command: 'echo "tag=${POOL_TAG:-missing}"' });
    assert(extractId(survivor) === poolIds[1], 'survivor probe reuses existing session');
    assert(/tag=slot1/.test(survivor), `non-oldest sessions retained across pool pressure (got: ${JSON.stringify(survivor)})`);
    // Now probe the evicted id. This will spawn a fresh shell (stable
    // resume) — close it right away so leftover pool state stays tidy.
    const probe = await run({ session_id: poolIds[0], command: 'echo "tag=${POOL_TAG:-missing}"', close: true });
    assert(/tag=missing/.test(probe), `11th session evicted oldest idle entry (got: ${JSON.stringify(probe)})`);
  }

  // ── 7. stderr separated into its own block ───────────────────────────
  {
    const r = await run({ command: 'echo stdout-line && echo stderr-line 1>&2' });
    track(extractId(r));
    assert(/\bstdout-line\b/.test(r), 'stdout content rendered in body');
    assert(/\n\[stderr\]\n/.test(r), `[stderr] block separator present (got: ${JSON.stringify(r)})`);
    assert(/\bstderr-line\b/.test(r), 'stderr content rendered in stderr block');
  }

  // ── 8. Unknown session_id is minted (stable resume) ──────────────────
  {
    const bogusId = 'sess_deadbeef-dead-beef-dead-beefdeadbeef';
    const r = await run({ session_id: bogusId, command: 'echo resumed' });
    track(extractId(r));
    assert(extractId(r) === bogusId, `unknown session_id is minted verbatim (got: ${JSON.stringify(r)})`);
    assert(/\bresumed\b/.test(r), 'minted-from-unknown session executes the command');
  }

  // ── 8b. Large-file shell probes are blocked before a session is minted ──
  {
    const root = mkdtempSync(join(tmpdir(), 'trib-bash-session-large-'));
    const big = join(root, 'big.txt');
    try {
      writeFileSync(big, 'x'.repeat(60 * 1024), 'utf8');
      const r = await run({ command: `grep x ${JSON.stringify(big)}` });
      assert(r.startsWith('Error:'), `large-file bash_session probe blocked (got: ${JSON.stringify(r.slice(0, 120))})`);
      assert(!extractId(r), 'large-file probe does not mint a bash_session');
      assert(r.includes('large-file shell probe blocked'), 'large-file probe explains why it was blocked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ── 8c. Dynamic cd sync makes later relative probes use real shell cwd ──
  {
    const root = mkdtempSync(join(tmpdir(), 'trib-bash-session-dyncd-'));
    const big = join(root, 'huge.log');
    try {
      writeFileSync(big, 'x'.repeat(60 * 1024), 'utf8');
      const first = await run({ command: `ROOT=${JSON.stringify(root)}; cd "$ROOT" && echo primed` });
      const id = extractId(first);
      track(id);
      const second = await run({ session_id: id, command: 'cat huge.log' });
      assert(second.startsWith('Error:'), `dynamic cd later blocks relative large-file probe (got: ${JSON.stringify(second)})`);
      assert(second.includes('large-file shell probe blocked'), 'dynamic cd later uses actual shell cwd for probe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ── 9. Read-only bash_session keeps builtin caches warm ──────────────
  {
    const root = mkdtempSync(join(tmpdir(), 'trib-bash-cache-ro-'));
    try {
      mkdirSync(join(root, 'one'), { recursive: true });
      writeFileSync(join(root, 'one', 'a.txt'), 'hello\n', 'utf8');
      invalidateBuiltinResultCache();
      await executeBuiltinTool('list', { path: join(root, 'one') }, root);
      await executeBuiltinTool('list', { path: join(root, 'one') }, root);
      resetBuiltinCacheStatsForTesting();

      const res = await run({ command: `cd ${JSON.stringify(root)} && pwd && ls` });
      track(extractId(res));
      const afterShell = getBuiltinCacheStatsForTesting();
      const listAgain = await executeBuiltinTool('list', { path: join(root, 'one') }, root);
      const afterList = getBuiltinCacheStatsForTesting();

      assert(afterShell.globalInvalidations === 0, `read-only bash_session skips global cache invalidation (got: ${JSON.stringify(afterShell)})`);
      assert(afterList.hits >= 1, `builtin cache still hits after read-only bash_session (got: ${JSON.stringify(afterList)})`);
      assert(listAgain.includes('a.txt'), `cached list remains usable after read-only bash_session (got: ${JSON.stringify(listAgain)})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ── 10. Mutating bash_session still invalidates builtin caches ───────
  {
    const root = mkdtempSync(join(tmpdir(), 'trib-bash-cache-rw-'));
    try {
      mkdirSync(join(root, 'one'), { recursive: true });
      mkdirSync(join(root, 'two'), { recursive: true });
      writeFileSync(join(root, 'one', 'a.txt'), 'hello\n', 'utf8');
      writeFileSync(join(root, 'two', 'b.txt'), 'keep\n', 'utf8');
      invalidateBuiltinResultCache();
      await executeBuiltinTool('list', { path: join(root, 'one') }, root);
      await executeBuiltinTool('list', { path: join(root, 'one') }, root);
      await executeBuiltinTool('list', { path: join(root, 'two') }, root);
      await executeBuiltinTool('list', { path: join(root, 'two') }, root);
      resetBuiltinCacheStatsForTesting();

      const prime = await run({ command: `cd ${JSON.stringify(join(root, 'one'))}` });
      const sessionId = extractId(prime);
      track(sessionId);
      const res = await run({ session_id: sessionId, command: 'touch rel-created.txt' });
      track(extractId(res));
      const afterShell = getBuiltinCacheStatsForTesting();
      const listOne = await executeBuiltinTool('list', { path: join(root, 'one') }, root);
      const afterOne = getBuiltinCacheStatsForTesting();
      const listTwo = await executeBuiltinTool('list', { path: join(root, 'two') }, root);
      const afterTwo = getBuiltinCacheStatsForTesting();

      assert(afterShell.pathInvalidations >= 1 && afterShell.globalInvalidations === 0, `mutating bash_session now prefers path invalidation when paths are known (got: ${JSON.stringify(afterShell)})`);
      assert(afterOne.misses >= 1, `changed directory cache rebuilds after mutating bash_session (got: ${JSON.stringify(afterOne)})`);
      assert(afterTwo.hits >= 1, `unrelated directory cache survives mutating bash_session (got: ${JSON.stringify(afterTwo)})`);
      assert(listOne.includes('rel-created.txt'), `rebuilt list sees shell-created relative file (got: ${JSON.stringify(listOne)})`);
      assert(listTwo.includes('b.txt'), `unrelated cached list remains usable (got: ${JSON.stringify(listTwo)})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  await closeAll();
}

const total = passed + failed;
console.log(`\nPASS ${passed}/${total}`);
process.exit(failed > 0 ? 1 : 0);
