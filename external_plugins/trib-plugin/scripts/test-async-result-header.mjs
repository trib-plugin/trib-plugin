/**
 * Tests for the async-result `Done.` header that wraps recall / search /
 * explore notifications delivered via `notifications/claude/channel` with
 * `meta.type: "async_result"`.
 *
 * The header mirrors the Pool B worker "Done" shape emitted by
 * src/agent/index.mjs (`${modelTag}[${role}] ...`) so the user sees a
 * consistent format across bridge worker output and async sub-agent results.
 *
 * Exercises:
 *   1. `buildAsyncResultHeader()` pure-function format across tools and
 *      model-tag variants.
 *   2. `pushAsyncResult()` integration path with a mock `notifyFn` spy —
 *      one assertion per tool (recall / search / explore) that the emitted
 *      content starts with `[...] [tool] Done.\n\n` and that the original
 *      body is preserved verbatim after the header + blank line.
 *   3. Fallback path — no model tag available still emits a clean
 *      `[tool] Done.` header.
 *   4. `meta.type: "async_result"` is preserved (non-goal guardrail).
 */

import {
  buildAsyncResultHeader,
  pushAsyncResult,
} from '../src/agent/orchestrator/ai-wrapped-dispatch.mjs';
import {
  SMART_READ_MAX_BYTES,
  SMART_READ_MAX_LINES,
} from '../src/agent/orchestrator/tools/builtin.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ── buildAsyncResultHeader() ─────────────────────────────────────────────
{
  assert(
    buildAsyncResultHeader('recall', '3-5-haiku') === '[3-5-haiku] [recall] Done.',
    `buildAsyncResultHeader('recall', '3-5-haiku') → "[3-5-haiku] [recall] Done." (got "${buildAsyncResultHeader('recall', '3-5-haiku')}")`,
  );
  assert(
    buildAsyncResultHeader('search', 'opus-4-7') === '[opus-4-7] [search] Done.',
    `buildAsyncResultHeader('search', 'opus-4-7') → "[opus-4-7] [search] Done."`,
  );
  assert(
    buildAsyncResultHeader('explore', 'haiku-4-5') === '[haiku-4-5] [explore] Done.',
    `buildAsyncResultHeader('explore', 'haiku-4-5') → "[haiku-4-5] [explore] Done."`,
  );
  // Fallback when model tag is unavailable — still emits `[tool] Done.`.
  assert(
    buildAsyncResultHeader('recall', '') === '[recall] Done.',
    `buildAsyncResultHeader('recall', '') → "[recall] Done." (fallback)`,
  );
  assert(
    buildAsyncResultHeader('search', null) === '[search] Done.',
    `buildAsyncResultHeader('search', null) → "[search] Done." (fallback)`,
  );
}

// ── pushAsyncResult() integration via mock notifyFn spy ─────────────────
function mkSpy() {
  const calls = [];
  const fn = (content, meta) => { calls.push({ content, meta }); };
  return { fn, calls };
}

// recall — body starts with `[...] [recall] Done.\n\n` and original body preserved.
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  const body = '### Query 1: foo\nAnswer 1\n\n---\n\n### Query 2: bar\nAnswer 2';
  pushAsyncResult(ctx, 'async_recall_1', 'recall', ['foo', 'bar'], body);
  assert(spy.calls.length === 1, 'recall: notify called exactly once');
  const { content, meta } = spy.calls[0];
  assert(
    /^\[(?:[^\]]+\] )?\[recall\] Done\.\n\n/.test(content),
    `recall: content starts with "[...] [recall] Done.\\n\\n" (got ${JSON.stringify(content.slice(0, 80))})`,
  );
  // Original body (bodyHeader + blank + merged answer) preserved verbatim.
  const expectedOriginal = `recall — 2 queries\n\n${body}`;
  assert(
    content.endsWith(expectedOriginal),
    `recall: original body preserved verbatim after the Done header`,
  );
  assert(meta.type === 'async_result', 'recall: meta.type stays "async_result"');
  assert(meta.tool === 'recall', 'recall: meta.tool === "recall"');
}

// search — same assertions.
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  const body = 'Top hit: https://example.com\nSummary of findings.';
  pushAsyncResult(ctx, 'async_search_1', 'search', ['what is x'], body);
  assert(spy.calls.length === 1, 'search: notify called exactly once');
  const { content, meta } = spy.calls[0];
  assert(
    /^\[(?:[^\]]+\] )?\[search\] Done\.\n\n/.test(content),
    `search: content starts with "[...] [search] Done.\\n\\n" (got ${JSON.stringify(content.slice(0, 80))})`,
  );
  const expectedOriginal = `search — 1 query\n\n${body}`;
  assert(
    content.endsWith(expectedOriginal),
    'search: original body preserved verbatim',
  );
  assert(meta.type === 'async_result', 'search: meta.type stays "async_result"');
}

// explore — same assertions.
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  const body = 'Found files: src/foo.mjs, src/bar.mjs';
  pushAsyncResult(ctx, 'async_explore_1', 'explore', ['find x'], body);
  assert(spy.calls.length === 1, 'explore: notify called exactly once');
  const { content, meta } = spy.calls[0];
  assert(
    /^\[(?:[^\]]+\] )?\[explore\] Done\.\n\n/.test(content),
    `explore: content starts with "[...] [explore] Done.\\n\\n" (got ${JSON.stringify(content.slice(0, 80))})`,
  );
  const expectedOriginal = `explore — 1 query\n\n${body}`;
  assert(
    content.endsWith(expectedOriginal),
    'explore: original body preserved verbatim',
  );
  assert(meta.type === 'async_result', 'explore: meta.type stays "async_result"');
}

// Error path — header becomes `[tool] Failed.` (same prefix shape).
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  pushAsyncResult(ctx, 'async_err_1', 'recall', ['q'], '[explorer dispatch error] boom', { error: true });
  assert(spy.calls.length === 1, 'error: notify called once');
  const { content } = spy.calls[0];
  assert(
    /^\[(?:[^\]]+\] )?\[recall\] Failed\.\n\n/.test(content),
    `error: content starts with "[...] [recall] Failed.\\n\\n" (got ${JSON.stringify(content.slice(0, 80))})`,
  );
  assert(
    content.includes('[explorer dispatch error] boom'),
    'error: original error body preserved',
  );
}

// No-notify ctx is a safe no-op (guardrail).
{
  // Should not throw.
  let threw = false;
  try { pushAsyncResult({}, 'id', 'recall', ['q'], 'body'); } catch { threw = true; }
  assert(!threw, 'no-notify ctx: pushAsyncResult is a safe no-op');
}

// ── Smart truncation of merged body (reviewer coverage-gap #5) ───────────
// Large recall/search/explore merged bodies flow through `pushAsyncResult`
// → `smartReadTruncate` (30 KB / 600 line cap with head 200 / tail 100
// framing). The `Done.` header must be prepended AFTER truncation so it is
// never itself cut.

// Body under threshold — unchanged after wrap. Body is preserved verbatim
// at the tail of the emitted content.
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  const smallBody = '### Query 1: foo\nShort answer.';
  pushAsyncResult(ctx, 'async_small_1', 'recall', ['foo'], smallBody);
  const { content } = spy.calls[0];
  assert(
    content.endsWith(`recall — 1 query\n\n${smallBody}`),
    'smart-trunc: small body preserved verbatim (no truncation)',
  );
  assert(
    !content.includes('... [TRUNCATED'),
    'smart-trunc: small body has no truncation marker',
  );
}

// Body over threshold — truncated body with marker, header still intact.
// Generate > SMART_READ_MAX_LINES lines so the line-count trigger engages.
function mkLargeBody(lines) {
  const rows = [];
  for (let i = 1; i <= lines; i++) rows.push(`line ${i}: ` + 'x'.repeat(20));
  return rows.join('\n');
}
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  const largeBody = mkLargeBody(SMART_READ_MAX_LINES + 100); // 700 lines
  pushAsyncResult(ctx, 'async_big_1', 'recall', ['foo'], largeBody);
  const { content } = spy.calls[0];
  assert(
    /^\[(?:[^\]]+\] )?\[recall\] Done\.\n\n/.test(content),
    'smart-trunc: header intact on large body (Done. prefix preserved)',
  );
  assert(
    content.includes('... [TRUNCATED'),
    'smart-trunc: large body carries truncation marker',
  );
  assert(
    content.length < Buffer.byteLength(largeBody, 'utf8'),
    'smart-trunc: emitted content is shorter than original large body',
  );
  // First body line (line 1) survives in head slice; last body line
  // (line 700) survives in tail slice.
  assert(
    content.includes('line 1: ') && content.includes(`line ${SMART_READ_MAX_LINES + 100}: `),
    'smart-trunc: head + tail of large body both present after truncation',
  );
}

// All three tools (recall / search / explore) apply truncation identically.
{
  const largeBody = mkLargeBody(SMART_READ_MAX_LINES + 50);
  for (const tool of ['recall', 'search', 'explore']) {
    const spy = mkSpy();
    const ctx = { notifyFn: spy.fn };
    pushAsyncResult(ctx, `async_${tool}_big`, tool, ['q'], largeBody);
    const { content } = spy.calls[0];
    assert(
      content.includes('... [TRUNCATED') && new RegExp(`\\[${tool}\\] Done\\.`).test(content),
      `smart-trunc: ${tool} truncates + keeps header`,
    );
  }
}

// Header prepend happens AFTER truncation — specifically, when the body is
// over threshold, the emitted content must START with the `Done.` header
// (not a truncation marker or mid-body text). This guarantees the header
// itself is never the subject of the head/tail cut.
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  const largeBody = mkLargeBody(SMART_READ_MAX_LINES + 200);
  pushAsyncResult(ctx, 'async_order_1', 'search', ['q'], largeBody);
  const { content } = spy.calls[0];
  // Very first character must be `[` of the header — never a line of the
  // body, never a truncation marker.
  assert(
    content.startsWith('['),
    'smart-trunc: emitted content starts with "[" (header prepend AFTER truncation)',
  );
  const firstLine = content.split('\n', 1)[0];
  assert(
    /\] Done\.$/.test(firstLine),
    `smart-trunc: first line is the Done. header, not body content (got ${JSON.stringify(firstLine)})`,
  );
  // And the header itself contains no truncation marker.
  assert(
    !firstLine.includes('... [TRUNCATED'),
    'smart-trunc: header itself is never truncated',
  );
}

// Byte-threshold path — short-line body that crosses 30 KB by bytes even
// though line count is low. Confirms the bytes-based trigger in
// smartReadTruncate also engages through pushAsyncResult.
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  // 50 KB of content spread across ~250 lines — over byte cap, under line
  // cap. smartReadTruncate still engages via overByBytes.
  const rows = [];
  for (let i = 0; i < 250; i++) rows.push('y'.repeat(200));
  const byteHeavyBody = rows.join('\n');
  assert(
    Buffer.byteLength(byteHeavyBody, 'utf8') > SMART_READ_MAX_BYTES,
    'smart-trunc: fixture exceeds SMART_READ_MAX_BYTES',
  );
  pushAsyncResult(ctx, 'async_bytes_1', 'explore', ['q'], byteHeavyBody);
  const { content } = spy.calls[0];
  assert(
    content.includes('... [TRUNCATED'),
    'smart-trunc: byte-heavy body triggers truncation marker',
  );
}

// Empty body — no crash, header still emitted (body part just blank).
{
  const spy = mkSpy();
  const ctx = { notifyFn: spy.fn };
  let threw = false;
  try { pushAsyncResult(ctx, 'async_empty_1', 'recall', ['q'], ''); } catch { threw = true; }
  assert(!threw, 'smart-trunc: empty body does not throw');
  assert(spy.calls.length === 1, 'smart-trunc: empty body still emits notify');
  const { content } = spy.calls[0];
  assert(
    /\[recall\] Done\./.test(content),
    'smart-trunc: empty body still carries the Done. header',
  );
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
