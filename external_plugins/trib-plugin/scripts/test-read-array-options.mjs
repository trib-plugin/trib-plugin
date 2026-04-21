#!/usr/bin/env node
// Verifies that `read` with `path` as an array propagates per-call options
// (mode / n / offset / limit / full) to each per-file entry instead of
// silently dropping them.
//
// Regression: before the fix, read({path:[a,b], mode:'head', n:1}) returned
// full file content because only `path` was forwarded to multi_read.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBuiltinTool } from '../src/agent/orchestrator/tools/builtin.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (cond) { passed++; }
    else { failed++; console.error(`FAIL: ${msg}`); }
}

const workDir = mkdtempSync(join(tmpdir(), 'read-array-opts-'));
const fileA = join(workDir, 'a.md');
const fileB = join(workDir, 'b.md');
const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
writeFileSync(fileA, lines);
writeFileSync(fileB, lines);

try {
    // 1. mode:'head' + n:1 — each file's output should contain exactly one content line
    const headRes = await executeBuiltinTool('read', {
        path: [fileA, fileB],
        mode: 'head',
        n: 1,
    }, workDir);
    const headBodies = headRes.split(/^### /m).filter(Boolean);
    assert(headBodies.length === 2, `head mode returned 2 sections (got ${headBodies.length})`);
    // Each section body must NOT contain "line 2" (since n:1 and head)
    const hasLine2 = /line 2\b/.test(headRes);
    assert(!hasLine2, `head mode n:1 should omit "line 2" from output (got: ${headRes.slice(0, 200)})`);
    const hasLine1 = (headRes.match(/line 1\b/g) || []).length >= 2;
    assert(hasLine1, 'head mode n:1 should contain "line 1" in both sections');

    // 2. mode:'count' — should return a count line per file, no body content
    const countRes = await executeBuiltinTool('read', {
        path: [fileA, fileB],
        mode: 'count',
    }, workDir);
    assert(!/line 10\b/.test(countRes), 'count mode should not include file body');

    // 3. mode:'tail' + n:2 — last 2 lines per file; line 1 should not appear
    const tailRes = await executeBuiltinTool('read', {
        path: [fileA, fileB],
        mode: 'tail',
        n: 2,
    }, workDir);
    assert(/line 20\b/.test(tailRes), 'tail mode n:2 should include last line');
    assert(!/line 1\b(?!\d)/.test(tailRes), 'tail mode n:2 should not include "line 1"');

    // 4. Sanity — plain array with no options should work like before
    const plainRes = await executeBuiltinTool('read', {
        path: [fileA],
    }, workDir);
    assert(/line 20\b/.test(plainRes), 'plain array read returns full body');
} finally {
    rmSync(workDir, { recursive: true, force: true });
}

if (failed > 0) {
    console.error(`test-read-array-options: ${passed} passed, ${failed} failed`);
    console.log(`PASS ${passed}/${passed + failed}`);
    process.exit(1);
}

console.log(`test-read-array-options: ${passed} passed`);
console.log(`PASS ${passed}/${passed}`);
process.exit(0);
