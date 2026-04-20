/**
 * Tests for the `apply_patch` tool (src/agent/orchestrator/tools/patch.mjs).
 * Shipped in v0.6.224~233.
 *
 * Coverage (≥ 10 assertions):
 *   1. Single-file modify patch — existing lines rewritten on disk.
 *   2. Multi-file patch — two files in one call, both written.
 *   3. Create (/dev/null → new file).
 *   4. Delete (file → /dev/null).
 *   5. dry_run:true — preview returned, no disk writes.
 *   6. reject_partial:true (default) — one bad hunk rejects the whole batch,
 *      no file touched (even the would-be-ok sibling).
 *   7. reject_partial:false — successful files apply even when others fail.
 *   8. git-style `a/foo` / `b/foo` prefix auto-stripped.
 *   9. Scope check — path outside base_path refused.
 *  10. Mismatched context line → reported as failed hunk.
 *
 * Plain node assertions, no framework. `os.tmpdir()` + `mkdtempSync` fixtures
 * cleaned up in finally. Prints `PASS N/M` at the end.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePatchTool } from '../src/agent/orchestrator/tools/patch.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

async function call(args, cwd) {
  return executePatchTool('apply_patch', args, cwd);
}

// Pre-shaped diffs — hand-rolled rather than generated via createTwoFilesPatch
// so the header lines in each test are explicit and easy to reason about.
function modifyDiff(name, fromLines, toLines, { prefix = 'a/', bPrefix = 'b/' } = {}) {
  const oldBody = fromLines.join('\n') + '\n';
  const newBody = toLines.join('\n') + '\n';
  // We always emit a single hunk spanning the whole file — the test files
  // are tiny so that's fine, and keeps the parsePatch input trivial.
  const hunkLines = [];
  // Build the hunk line-by-line by diffing the two arrays with a naive LCS
  // -free approach: identical prefix as context, then `-`/`+` runs, then
  // identical suffix. For the shapes we use here that's sufficient.
  let i = 0;
  while (i < fromLines.length && i < toLines.length && fromLines[i] === toLines[i]) {
    hunkLines.push(' ' + fromLines[i]);
    i++;
  }
  // Remaining old lines → `-`, remaining new lines → `+`.
  for (let j = i; j < fromLines.length; j++) hunkLines.push('-' + fromLines[j]);
  for (let j = i; j < toLines.length; j++) hunkLines.push('+' + toLines[j]);
  const header = `@@ -1,${fromLines.length} +1,${toLines.length} @@`;
  return (
    `--- ${prefix}${name}\n` +
    `+++ ${bPrefix}${name}\n` +
    `${header}\n` +
    hunkLines.join('\n') + '\n'
  );
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'apply-patch-test-'));
try {
  // ── 1. Single-file modify ─────────────────────────────────────────────
  {
    const name = 'single.txt';
    const full = join(tmpRoot, name);
    writeFileSync(full, 'hello\nworld\n', 'utf-8');
    const patch = modifyDiff(name, ['hello', 'world'], ['hello', 'EARTH']);
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(/applied: 1 file/.test(res), `single-file modify reports applied: got ${JSON.stringify(res)}`);
    assert(
      readFileSync(full, 'utf-8') === 'hello\nEARTH\n',
      `single-file modify rewrote body (got ${JSON.stringify(readFileSync(full, 'utf-8'))})`
    );
  }

  // ── 2. Multi-file patch in one call ───────────────────────────────────
  {
    const aName = 'multi-a.txt';
    const bName = 'multi-b.txt';
    const aFull = join(tmpRoot, aName);
    const bFull = join(tmpRoot, bName);
    writeFileSync(aFull, 'aaa\nbbb\n', 'utf-8');
    writeFileSync(bFull, 'ccc\nddd\n', 'utf-8');
    const patch =
      modifyDiff(aName, ['aaa', 'bbb'], ['aaa', 'BBB']) +
      modifyDiff(bName, ['ccc', 'ddd'], ['ccc', 'DDD']);
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(/applied: 2 file/.test(res), `multi-file modify applied count: got ${JSON.stringify(res)}`);
    assert(readFileSync(aFull, 'utf-8') === 'aaa\nBBB\n', 'multi-file: first file rewritten');
    assert(readFileSync(bFull, 'utf-8') === 'ccc\nDDD\n', 'multi-file: second file rewritten');
  }

  // ── 3. Create (/dev/null → new file) ──────────────────────────────────
  {
    const name = 'created.txt';
    const full = join(tmpRoot, name);
    const body = 'fresh line 1\nfresh line 2\n';
    // Create patches in `diff` library form: old is /dev/null, new has hunks
    // that add every line from 0,0 → 1,N.
    const addedLines = body.replace(/\n$/, '').split('\n');
    const patch =
      `--- /dev/null\n` +
      `+++ b/${name}\n` +
      `@@ -0,0 +1,${addedLines.length} @@\n` +
      addedLines.map(l => '+' + l).join('\n') + '\n';
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(/applied: 1 file/.test(res) && /create/.test(res), `create: summary mentions create (got ${JSON.stringify(res)})`);
    assert(existsSync(full) && readFileSync(full, 'utf-8') === body, 'create: file exists with expected body');
  }

  // ── 4. Delete (file → /dev/null) ──────────────────────────────────────
  {
    const name = 'doomed.txt';
    const full = join(tmpRoot, name);
    const body = 'line1\nline2\n';
    writeFileSync(full, body, 'utf-8');
    const oldLines = body.replace(/\n$/, '').split('\n');
    const patch =
      `--- a/${name}\n` +
      `+++ /dev/null\n` +
      `@@ -1,${oldLines.length} +0,0 @@\n` +
      oldLines.map(l => '-' + l).join('\n') + '\n';
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(/applied: 1 file/.test(res) && /delete/.test(res), `delete: summary mentions delete (got ${JSON.stringify(res)})`);
    assert(!existsSync(full), 'delete: target file removed from disk');
  }

  // ── 5. dry_run — preview only, no disk writes ─────────────────────────
  {
    const name = 'dry.txt';
    const full = join(tmpRoot, name);
    writeFileSync(full, 'unchanged body\n', 'utf-8');
    const patch = modifyDiff(name, ['unchanged body'], ['MUTATED BODY']);
    const res = await call({ patch, base_path: tmpRoot, dry_run: true }, tmpRoot);
    assert(/^dry-run:/.test(res), `dry_run: preview prefix (got ${JSON.stringify(res)})`);
    assert(
      readFileSync(full, 'utf-8') === 'unchanged body\n',
      'dry_run: disk content was NOT modified'
    );
  }

  // ── 6. reject_partial default true — bad sibling kills the batch ──────
  {
    const okName = 'atomic-ok.txt';
    const badName = 'atomic-bad.txt';
    const okFull = join(tmpRoot, okName);
    const badFull = join(tmpRoot, badName);
    writeFileSync(okFull, 'ok-before\n', 'utf-8');
    writeFileSync(badFull, 'actual-content\n', 'utf-8');
    // First entry is a valid modify; second entry claims context `wrong-context`
    // which does not match `actual-content`, so applyPatch rejects it.
    const patch =
      modifyDiff(okName, ['ok-before'], ['ok-after']) +
      modifyDiff(badName, ['wrong-context'], ['ok-after']);
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(/patch rejected/i.test(res), `reject_partial default: error surfaces (got ${JSON.stringify(res)})`);
    assert(
      readFileSync(okFull, 'utf-8') === 'ok-before\n',
      'reject_partial default: ok sibling NOT written (atomic rollback)'
    );
    assert(
      readFileSync(badFull, 'utf-8') === 'actual-content\n',
      'reject_partial default: bad target untouched'
    );
  }

  // ── 7. reject_partial:false — good file lands, bad file reported ──────
  {
    const okName = 'partial-ok.txt';
    const badName = 'partial-bad.txt';
    const okFull = join(tmpRoot, okName);
    const badFull = join(tmpRoot, badName);
    writeFileSync(okFull, 'ok-before\n', 'utf-8');
    writeFileSync(badFull, 'actual-content\n', 'utf-8');
    const patch =
      modifyDiff(okName, ['ok-before'], ['ok-after']) +
      modifyDiff(badName, ['wrong-context'], ['ok-after']);
    const res = await call({ patch, base_path: tmpRoot, reject_partial: false }, tmpRoot);
    assert(/applied: 1 file/.test(res) && /FAIL/.test(res), `reject_partial=false: mixed report (got ${JSON.stringify(res)})`);
    assert(
      readFileSync(okFull, 'utf-8') === 'ok-after\n',
      'reject_partial=false: good file was written'
    );
    assert(
      readFileSync(badFull, 'utf-8') === 'actual-content\n',
      'reject_partial=false: bad file left untouched'
    );
  }

  // ── 8. Git-style a/ b/ prefix auto-stripped ───────────────────────────
  {
    const name = 'gitprefix.txt';
    const full = join(tmpRoot, name);
    writeFileSync(full, 'line-original\n', 'utf-8');
    // Headers explicitly use `a/` and `b/` prefixes; strippable and still
    // resolvable relative to base_path.
    const patch =
      `--- a/${name}\n` +
      `+++ b/${name}\n` +
      `@@ -1,1 +1,1 @@\n` +
      `-line-original\n` +
      `+line-replaced\n`;
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(/applied: 1 file/.test(res), `git-prefix: applied (got ${JSON.stringify(res)})`);
    assert(
      readFileSync(full, 'utf-8') === 'line-replaced\n',
      'git-prefix: a/ b/ stripped correctly and file rewritten'
    );
  }

  // ── 9. Scope check — path escapes base_path AND $HOME ─────────────────
  {
    // isSafePath permits paths inside either base_path or $HOME (so agents
    // writing into ~/.claude/... from an unrelated cwd still works). For
    // the escape test to actually trigger the refusal branch we point at
    // a filesystem-root path that's outside $HOME on every platform —
    // `C:/__trib_apply_patch_escape__.txt` on Windows, `/__trib_apply_...`
    // on POSIX. We don't write that file; the assertion is purely that the
    // handler returns a refusal string.
    const escapePath = process.platform === 'win32'
      ? 'C:/__trib_apply_patch_escape__.txt'
      : '/__trib_apply_patch_escape__.txt';
    const patch =
      `--- a${escapePath}\n` +
      `+++ b${escapePath}\n` +
      `@@ -1,1 +1,1 @@\n` +
      `-keep-me\n` +
      `+pwned\n`;
    const res = await call({ patch, base_path: tmpRoot }, tmpRoot);
    assert(
      /outside allowed scope/i.test(res) || /patch rejected/i.test(res),
      `scope check: escape attempt refused (got ${JSON.stringify(res)})`
    );
    assert(
      !existsSync(escapePath),
      'scope check: out-of-scope path NOT written to disk'
    );
  }

  // ── 10. Mismatched context line → failed hunk report ──────────────────
  {
    const name = 'mismatch.txt';
    const full = join(tmpRoot, name);
    writeFileSync(full, 'on-disk\n', 'utf-8');
    // Patch claims the file reads `expected-context` but the real content
    // is `on-disk`, so applyPatch rejects the hunk.
    const patch = modifyDiff(name, ['expected-context'], ['would-be']);
    // Use dry_run so the failed-hunk preview line (@@ ...) is emitted.
    const res = await call({ patch, base_path: tmpRoot, dry_run: true }, tmpRoot);
    assert(
      /FAIL/.test(res) && /hunk rejected|context mismatch/i.test(res),
      `mismatched context: failure reported (got ${JSON.stringify(res)})`
    );
    assert(/@@ -1,1 \+1,1 @@/.test(res), 'mismatched context: failed-hunk header shown in preview');
    assert(
      readFileSync(full, 'utf-8') === 'on-disk\n',
      'mismatched context: disk untouched (dry_run + failed hunk)'
    );
  }
} finally {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

const total = passed + failed;
console.log(`\nPASS ${passed}/${total}`);
process.exit(failed > 0 ? 1 : 0);
