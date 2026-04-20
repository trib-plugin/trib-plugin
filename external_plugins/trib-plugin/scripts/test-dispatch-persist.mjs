/**
 * Smoke tests for dispatch-persist — the crash / restart recovery layer that
 * survives plugin MCP server restarts mid-dispatch.
 *
 * Exercises:
 *   1. addPending() — writes an entry to pending-dispatches.json
 *   2. addPending() — multiple entries coexist
 *   3. removePending() — deletes the entry, leaves siblings alone
 *   4. recoverPending() — emits one Aborted notification per surviving entry
 *      with `type: 'dispatch_result'`, `error: true`, and an instruction that
 *      names the dispatch handle
 *   5. recoverPending() — clears the file after emitting (idempotent)
 *   6. recoverPending() — no pending entries → zero notifications, zero count
 *   7. Defensive — missing dataDir / handle / notifyFn are all no-ops
 *   8. TTL — entries older than 30 min are GC'd on the next add
 *   9. Persistence — data survives an explicit re-read (new process simulation)
 */

import {
  addPending,
  removePending,
  recoverPending,
} from '../src/agent/orchestrator/dispatch-persist.mjs';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'trib-dispatch-persist-'));
}

function readFile(dataDir) {
  const p = join(dataDir, 'pending-dispatches.json');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

// ── 1. addPending writes an entry ───────────────────────────────────────────
{
  const dir = freshDir();
  try {
    addPending(dir, 'dispatch_recall_1', 'recall', ['foo', 'bar']);
    const map = readFile(dir);
    assert(map && typeof map === 'object', 'addPending creates the file');
    assert(!!map?.dispatch_recall_1, 'addPending writes entry by handle key');
    assert(map?.dispatch_recall_1?.tool === 'recall', 'tool is persisted');
    assert(
      Array.isArray(map?.dispatch_recall_1?.queries)
      && map.dispatch_recall_1.queries.length === 2,
      'queries array is persisted verbatim',
    );
    assert(typeof map?.dispatch_recall_1?.createdAt === 'number', 'createdAt timestamp is present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. addPending — multiple entries coexist ────────────────────────────────
{
  const dir = freshDir();
  try {
    addPending(dir, 'dispatch_recall_1', 'recall', ['a']);
    addPending(dir, 'dispatch_search_2', 'search', ['b', 'c']);
    addPending(dir, 'dispatch_explore_3', 'explore', ['d']);
    const map = readFile(dir);
    assert(Object.keys(map || {}).length === 3, 'three independent entries coexist');
    assert(map?.dispatch_search_2?.tool === 'search', 'second entry retains its tool');
    assert(
      map?.dispatch_explore_3?.queries?.[0] === 'd',
      'third entry retains its queries',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 3. removePending deletes one, leaves siblings ───────────────────────────
{
  const dir = freshDir();
  try {
    addPending(dir, 'dispatch_a', 'recall', ['x']);
    addPending(dir, 'dispatch_b', 'search', ['y']);
    removePending(dir, 'dispatch_a');
    const map = readFile(dir);
    assert(!map?.dispatch_a, 'removePending deletes target entry');
    assert(!!map?.dispatch_b, 'removePending leaves siblings intact');
    // Removing a non-existent handle is a no-op.
    removePending(dir, 'dispatch_nonexistent');
    const map2 = readFile(dir);
    assert(!!map2?.dispatch_b, 'removing a missing handle is a no-op');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4 + 5. recoverPending emits aborted Noti + clears file ──────────────────
{
  const dir = freshDir();
  try {
    addPending(dir, 'dispatch_recall_abort', 'recall', ['q1']);
    addPending(dir, 'dispatch_explore_abort', 'explore', ['q2', 'q3']);

    const captured = [];
    const notifyFn = (content, meta) => { captured.push({ content, meta }); };

    const count = recoverPending(dir, notifyFn);
    assert(count === 2, `recoverPending returns count of aborted entries (got ${count})`);
    assert(captured.length === 2, 'one Noti emitted per pending entry');

    const byTool = Object.fromEntries(captured.map(c => [c.meta?.tool, c]));
    assert(!!byTool.recall, 'recall entry emitted a Noti');
    assert(!!byTool.explore, 'explore entry emitted a Noti');

    const recallNoti = byTool.recall;
    assert(
      recallNoti.meta?.type === 'dispatch_result',
      `meta.type === 'dispatch_result' (got ${recallNoti.meta?.type})`,
    );
    assert(recallNoti.meta?.error === true, 'meta.error === true on aborted recovery');
    assert(
      recallNoti.meta?.dispatch_id === 'dispatch_recall_abort',
      'meta.dispatch_id matches the original handle',
    );
    assert(
      typeof recallNoti.meta?.instruction === 'string'
      && recallNoti.meta.instruction.includes('dispatch_recall_abort'),
      'meta.instruction references the aborted handle',
    );
    assert(
      recallNoti.content.startsWith('[recall] Aborted'),
      `content starts with '[recall] Aborted' (got "${recallNoti.content.slice(0, 40)}")`,
    );
    assert(
      recallNoti.content.includes('1 query'),
      'recall content reports "1 query" (singular) for a single-query dispatch',
    );
    assert(
      byTool.explore.content.includes('2 queries'),
      'explore content reports "2 queries" (plural) for a multi-query dispatch',
    );

    // File is cleared after emission — a second recover yields zero.
    const map = readFile(dir);
    assert(
      !map || Object.keys(map).length === 0,
      'pending-dispatches.json is cleared after recover',
    );

    const second = [];
    const count2 = recoverPending(dir, (c, m) => second.push({ c, m }));
    assert(count2 === 0, 'second recover returns 0 (idempotent)');
    assert(second.length === 0, 'second recover emits no Notis (idempotent)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. recoverPending — empty state ─────────────────────────────────────────
{
  const dir = freshDir();
  try {
    let emitted = 0;
    const count = recoverPending(dir, () => { emitted++; });
    assert(count === 0, 'empty dir recover returns 0');
    assert(emitted === 0, 'empty dir recover emits nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 7. Defensive — missing args are no-ops ──────────────────────────────────
{
  let threw = false;
  try {
    addPending(null, 'h', 'recall', ['q']);
    addPending('', 'h', 'recall', ['q']);
    removePending(null, 'h');
    removePending('/tmp/whatever', '');
    const c1 = recoverPending(null, () => {});
    const c2 = recoverPending('/tmp/whatever', null);
    assert(c1 === 0, 'recoverPending with null dataDir → 0');
    assert(c2 === 0, 'recoverPending with non-function notifyFn → 0');
  } catch (err) {
    threw = true;
    console.error(`  defensive path threw: ${err?.message}`);
  }
  assert(!threw, 'defensive calls never throw');
}

// ── 8. TTL — stale entries are GC'd on next add ────────────────────────────
{
  const dir = freshDir();
  try {
    // Manually write an entry with a createdAt 1 hour in the past.
    const stalePath = join(dir, 'pending-dispatches.json');
    const stale = {
      dispatch_old: {
        tool: 'recall',
        queries: ['stale'],
        createdAt: Date.now() - 60 * 60_000,
      },
    };
    writeFileSync(stalePath, JSON.stringify(stale), 'utf8');

    // Adding a fresh entry triggers gc() and should drop the stale one.
    addPending(dir, 'dispatch_fresh', 'search', ['new']);

    const map = readFile(dir);
    assert(!map?.dispatch_old, 'TTL-expired entry is GC\'d on next add');
    assert(!!map?.dispatch_fresh, 'fresh entry survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 9. Persistence — survives re-read (new process simulation) ──────────────
{
  const dir = freshDir();
  try {
    addPending(dir, 'dispatch_persist_check', 'explore', ['persisted']);

    // Simulate a new process lifetime: re-read the file from scratch.
    const raw = readFileSync(join(dir, 'pending-dispatches.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert(!!parsed?.dispatch_persist_check, 'entry survives a fresh file read');
    assert(
      parsed.dispatch_persist_check.queries?.[0] === 'persisted',
      'queries survive a fresh file read verbatim',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`PASS ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
