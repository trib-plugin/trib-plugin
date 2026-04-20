/**
 * Tests for smartMiddleTruncate() + smartReadTruncate() shipped in
 * v0.6.224~233 (see src/agent/orchestrator/tools/builtin.mjs). These
 * helpers front every bash/bash_session/read/multi_read payload the
 * agent loop pushes back to the model, so head/tail framing and the
 * boundary conditions decide whether big outputs stay cache-cheap or
 * blow Pool B's cache_write budget (~30-40k tokens per iter was the
 * pre-truncation regression these guards prevent).
 *
 * Coverage:
 *   - Small inputs pass through unchanged.
 *   - Over line threshold only → head+marker+tail with correct slice counts.
 *   - Over byte threshold only → truncated (single-line + multi-line paths).
 *   - Exactly at threshold (not strictly over) → unchanged.
 *   - Huge single-line no-newline input → handled (no crash, still output).
 *   - Marker substring check ("TRUNCATED", line count present).
 *   - Empty-string input → unchanged.
 *   - bash variant uses bash constants, read variant uses read constants
 *     (different head/tail slice sizes prove the two helpers are independent).
 */

import {
    smartMiddleTruncate,
    smartReadTruncate,
    SMART_READ_MAX_BYTES,
    SMART_READ_MAX_LINES,
    SMART_READ_HEAD_LINES,
    SMART_READ_TAIL_LINES,
    SMART_BASH_MAX_LINES,
    SMART_BASH_MAX_BYTES,
    SMART_BASH_HEAD_LINES,
    SMART_BASH_TAIL_LINES,
} from '../src/agent/orchestrator/tools/builtin.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ── Constants sanity (locks the contract the task brief references) ───
assert(SMART_BASH_MAX_BYTES === 30 * 1024, `SMART_BASH_MAX_BYTES = 30KB (got ${SMART_BASH_MAX_BYTES})`);
assert(SMART_BASH_MAX_LINES === 400, `SMART_BASH_MAX_LINES = 400 (got ${SMART_BASH_MAX_LINES})`);
assert(SMART_BASH_HEAD_LINES === 80, `SMART_BASH_HEAD_LINES = 80 (got ${SMART_BASH_HEAD_LINES})`);
assert(SMART_BASH_TAIL_LINES === 80, `SMART_BASH_TAIL_LINES = 80 (got ${SMART_BASH_TAIL_LINES})`);
assert(SMART_READ_MAX_BYTES === 30 * 1024, `SMART_READ_MAX_BYTES = 30KB (got ${SMART_READ_MAX_BYTES})`);
assert(SMART_READ_MAX_LINES === 600, `SMART_READ_MAX_LINES = 600 (got ${SMART_READ_MAX_LINES})`);
assert(SMART_READ_HEAD_LINES === 200, `SMART_READ_HEAD_LINES = 200 (got ${SMART_READ_HEAD_LINES})`);
assert(SMART_READ_TAIL_LINES === 100, `SMART_READ_TAIL_LINES = 100 (got ${SMART_READ_TAIL_LINES})`);

// ── smartMiddleTruncate (bash/bash_session) ───────────────────────────

// 1. Empty input → unchanged, no crash.
{
    const out = smartMiddleTruncate('');
    assert(out === '', `empty string passes through (got length ${out.length})`);
}

// 2. Small input (well below both caps) → unchanged.
{
    const small = 'hello world\nline two\nline three';
    const out = smartMiddleTruncate(small);
    assert(out === small, 'small multi-line input returned unchanged');
}

// 3. Over line threshold only (line count > 400, bytes under 30KB).
//    500 lines of 'x' = 500 chars + 499 newlines = 999 bytes → well under 30KB.
{
    const lines = Array.from({ length: 500 }, (_, i) => `r${i}`);
    const input = lines.join('\n');
    const out = smartMiddleTruncate(input);
    assert(out !== input, 'over-line-threshold triggers truncation');
    assert(out.includes('TRUNCATED'), 'marker contains TRUNCATED substring');
    // 500 - 80 - 80 = 340 middle lines elided.
    assert(out.includes('340 lines middle elided'), `marker reports 340 elided lines (got marker segment: ${out.slice(out.indexOf('TRUNCATED'), out.indexOf('TRUNCATED') + 80)})`);
    assert(out.includes('total 500 lines'), 'marker reports total 500 lines');
    // Head and tail slice counts match constants exactly.
    const headSlice = out.slice(0, out.indexOf('\n\n...'));
    const tailSlice = out.slice(out.lastIndexOf('...\n\n') + '...\n\n'.length);
    assert(headSlice.split('\n').length === SMART_BASH_HEAD_LINES, `head has ${SMART_BASH_HEAD_LINES} lines (got ${headSlice.split('\n').length})`);
    assert(tailSlice.split('\n').length === SMART_BASH_TAIL_LINES, `tail has ${SMART_BASH_TAIL_LINES} lines (got ${tailSlice.split('\n').length})`);
    assert(headSlice.startsWith('r0\nr1\n'), 'head preserves first rows');
    assert(tailSlice.endsWith('r499'), 'tail preserves last row');
}

// 4. Over byte threshold only (bytes > 30KB, lines <= 400).
//    50 lines × 1000 bytes = 50_050 bytes, line count 50 ≪ 400.
{
    const bigLine = 'x'.repeat(1000);
    const lines = Array.from({ length: 50 }, () => bigLine);
    const input = lines.join('\n');
    const out = smartMiddleTruncate(input);
    assert(out !== input, 'over-byte-threshold triggers truncation');
    assert(out.length < input.length, 'truncated output shorter than input');
    // Single-giant-line path: marker says "single line" (50 short-ish lines
    // still hits the "moderate line count" branch — head byte slice + marker).
    assert(out.includes('TRUNCATED'), 'byte-only path emits TRUNCATED marker');
    assert(out.includes('30 KB'), 'marker references the 30 KB cap');
}

// 5. Very long single line with no newlines, bytes over threshold →
//    handled without crash, still produces output.
{
    const mono = 'z'.repeat(SMART_BASH_MAX_BYTES + 5000);
    const out = smartMiddleTruncate(mono);
    assert(typeof out === 'string' && out.length > 0, 'single-line-no-newline input produces non-empty string');
    assert(out.length < mono.length, 'single-line-no-newline gets truncated');
    assert(out.includes('single line'), 'single-line-no-newline path marker mentions single line');
}

// 6. Exactly at line threshold (== SMART_BASH_MAX_LINES, 400 rows) →
//    NOT truncated. 400 short rows, byte count tiny.
{
    const rows = Array.from({ length: SMART_BASH_MAX_LINES }, (_, i) => String(i));
    const input = rows.join('\n');
    const out = smartMiddleTruncate(input);
    assert(out === input, `exactly ${SMART_BASH_MAX_LINES} lines is NOT truncated (boundary ==)`);
}

// 7. Just-over line threshold (== SMART_BASH_MAX_LINES + 1) → truncated.
{
    const rows = Array.from({ length: SMART_BASH_MAX_LINES + 1 }, (_, i) => String(i));
    const input = rows.join('\n');
    const out = smartMiddleTruncate(input);
    assert(out !== input, `${SMART_BASH_MAX_LINES + 1} lines IS truncated (strictly over)`);
}

// 8. Non-string input coerces safely (null → '').
{
    const out = smartMiddleTruncate(null);
    assert(out === '', 'null input coerces to empty string, no crash');
}

// ── smartReadTruncate (read/multi_read) ───────────────────────────────

// 9. Small input → unchanged, truncated:false.
{
    const rendered = '   1\tfoo\n   2\tbar\n   3\tbaz';
    const res = smartReadTruncate(rendered, 3, rendered.length);
    assert(res.text === rendered && res.truncated === false, 'small read returns unchanged with truncated:false');
    assert(res.totalLines === 3, 'totalLines echoed back');
}

// 10. Over line threshold only (601 lines, bytes under 30KB).
{
    const rows = Array.from({ length: 601 }, (_, i) => `${String(i + 1).padStart(4)}\t${i}`);
    const rendered = rows.join('\n');
    const res = smartReadTruncate(rendered, 601, rendered.length);
    assert(res.truncated === true, 'read over line cap → truncated:true');
    assert(res.text.includes('TRUNCATED'), 'read truncation marker contains TRUNCATED');
    assert(res.text.includes('601 lines'), 'marker reports 601 lines');
    // Head=200 rows, tail=100 rows → text split count = 200 + 1 (marker) + 100 = 301.
    const parts = res.text.split('\n');
    assert(parts.length === SMART_READ_HEAD_LINES + 1 + SMART_READ_TAIL_LINES, `read output lines = head + marker + tail (got ${parts.length})`);
}

// 11. Over byte threshold only (flag via fileBytes arg, even when totalLines <= 600).
{
    const rendered = 'tiny\nrendered\nbody';
    const res = smartReadTruncate(rendered, 3, SMART_READ_MAX_BYTES + 10_000);
    assert(res.truncated === true, 'fileBytes over cap forces truncated:true even with few lines');
    assert(res.text.includes('TRUNCATED'), 'byte-path still emits TRUNCATED marker');
}

// 12. Exactly at boundaries (== SMART_READ_MAX_LINES AND == SMART_READ_MAX_BYTES) → NOT truncated.
{
    const rows = Array.from({ length: SMART_READ_MAX_LINES }, (_, i) => `l${i}`);
    const rendered = rows.join('\n');
    const res = smartReadTruncate(rendered, SMART_READ_MAX_LINES, SMART_READ_MAX_BYTES);
    assert(res.truncated === false, 'read: exactly at line cap + byte cap → NOT truncated (strict > only)');
    assert(res.text === rendered, 'read boundary: text returned verbatim');
}

// 13. bash vs read use independent constants — identical 500-row input
//     should be UNCHANGED by smartReadTruncate (500 <= 600) but TRUNCATED
//     by smartMiddleTruncate (500 > 400).
{
    const rows = Array.from({ length: 500 }, (_, i) => `row${i}`);
    const input = rows.join('\n');
    const readRes = smartReadTruncate(input, 500, input.length);
    const bashOut = smartMiddleTruncate(input);
    assert(readRes.truncated === false, '500 rows: read helper keeps it (under 600-line cap)');
    assert(bashOut !== input, '500 rows: bash helper truncates (over 400-line cap)');
    // And read's head slice size differs from bash's — prove we're not
    // cross-wiring constants by forcing a read-side truncation and checking
    // slice size matches SMART_READ_HEAD_LINES (200), not SMART_BASH_HEAD_LINES (80).
    const bigRows = Array.from({ length: 700 }, (_, i) => `row${i}`);
    const bigInput = bigRows.join('\n');
    const readBig = smartReadTruncate(bigInput, 700, bigInput.length);
    const readParts = readBig.text.split('\n');
    // head(200) + marker(1) + tail(100) = 301
    assert(readParts.length === SMART_READ_HEAD_LINES + 1 + SMART_READ_TAIL_LINES,
        `read uses its own head/tail (got ${readParts.length} parts, expected ${SMART_READ_HEAD_LINES + 1 + SMART_READ_TAIL_LINES})`);
    // Same input through bash helper: head(80) + blank + marker + blank + tail(80)
    // = 80 + 1 + 1 + 1 + 80 = 163 parts (the "\n\n...\n\n" wrap contributes 3 split boundaries).
    const bashBig = smartMiddleTruncate(bigInput);
    const bashParts = bashBig.split('\n');
    assert(bashParts.length === SMART_BASH_HEAD_LINES + 3 + SMART_BASH_TAIL_LINES,
        `bash uses its own head/tail (got ${bashParts.length} parts, expected ${SMART_BASH_HEAD_LINES + 3 + SMART_BASH_TAIL_LINES})`);
}

const total = passed + failed;
console.log(`\nPASS ${passed}/${total}`);
process.exit(failed > 0 ? 1 : 0);
