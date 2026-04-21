/**
 * Tests for the v0.6.230 bash accuracy improvements on the `bash` tool
 * handler in src/agent/orchestrator/tools/builtin.mjs.
 *
 * Four fixes under test:
 *   1. ANSI / VT control stripping (util.stripVTControlCharacters preferred,
 *      regex fallback) — CSI + OSC sequences both disappear.
 *   2. stderr separation — by default stderr is emitted as a distinct
 *      `[stderr]` block, never merged into stdout. Pure-stdout runs stay
 *      clean (no block).
 *   3. LANG=C.UTF-8 — locale env is forced deterministic.
 *   4. Exit code surfacing — non-zero status produces an `[exit code: N]`
 *      marker; exit 0 stays silent; blocked patterns return a clear
 *      refusal (not an exit-code line).
 *   5. merge_stderr=true legacy flag — stderr merges back into stdout.
 *
 * All tests go through `executeBuiltinTool('bash', ...)` which is the same
 * dispatch the registry uses. Plain node assertions, no framework.
 */

import { executeBuiltinTool } from '../src/agent/orchestrator/tools/builtin.mjs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
    if (cond) passed++;
    else {
        failed++;
        failures.push(msg);
        console.error(`  FAIL: ${msg}`);
    }
}

// Probe for an sh-compatible shell. On Windows + Git Bash this resolves;
// if none is available we skip the shell-driven assertions cleanly rather
// than spawning cmd.exe (which would flunk POSIX syntax used in tests).
function shellAvailable() {
    if (process.platform !== 'win32') return true;
    const candidates = [
        process.env.CLAUDE_CODE_SHELL,
        process.env.SHELL,
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
        'C:\\msys64\\usr\\bin\\bash.exe',
    ].filter(Boolean);
    return candidates.some(p => { try { return existsSync(p); } catch { return false; } });
}

if (!shellAvailable()) {
    console.log('SKIP: no sh-compatible shell available on this host');
    console.log('PASS 0/0');
    process.exit(0);
}

const cwd = process.cwd();

// ── 1. ANSI strip — red CSI ────────────────────────────────────────────
{
    const out = await executeBuiltinTool('bash', {
        command: `printf '\\x1b[31mred\\x1b[0m\\n'`,
    }, cwd);
    assert(typeof out === 'string' && out.includes('red'),
        `ANSI CSI: output contains "red" (got: ${JSON.stringify(out)})`);
    assert(!/\u001B\[/.test(out),
        `ANSI CSI: no raw ESC-[ bytes remain (got: ${JSON.stringify(out)})`);
}

// ── 2. ANSI strip — OSC (hyperlink / title) ────────────────────────────
{
    // ESC ] 0 ; title BEL   → OSC title set; also include a CSI for good measure.
    const out = await executeBuiltinTool('bash', {
        command: `printf '\\x1b]0;my-title\\x07\\x1b[32mgreen\\x1b[0m done\\n'`,
    }, cwd);
    assert(out.includes('green') && out.includes('done'),
        `ANSI OSC: payload text preserved (got: ${JSON.stringify(out)})`);
    assert(!/\u001B\]/.test(out) && !/\u0007/.test(out),
        `ANSI OSC: ESC-] and BEL stripped (got: ${JSON.stringify(out)})`);
    assert(!/\u001B\[/.test(out),
        `ANSI CSI also stripped alongside OSC`);
}

// ── 3. stderr separation — distinct [stderr] block ─────────────────────
{
    const out = await executeBuiltinTool('bash', {
        command: `echo out; echo err >&2`,
    }, cwd);
    assert(out.includes('[stderr]'),
        `stderr: [stderr] header present (got: ${JSON.stringify(out)})`);
    const stderrIdx = out.indexOf('[stderr]');
    const stdoutPart = out.slice(0, stderrIdx);
    const stderrPart = out.slice(stderrIdx);
    assert(stdoutPart.includes('out'),
        `stderr: stdout section retains "out"`);
    assert(!stdoutPart.includes('err'),
        `stderr: stdout section does NOT contain "err" (got stdoutPart: ${JSON.stringify(stdoutPart)})`);
    assert(stderrPart.includes('err'),
        `stderr: stderr section contains "err"`);
}

// ── 4. stderr: pure-stdout command → no [stderr] block ─────────────────
{
    const out = await executeBuiltinTool('bash', {
        command: `echo hello-world`,
    }, cwd);
    assert(out.includes('hello-world'),
        `pure stdout: content present`);
    assert(!out.includes('[stderr]'),
        `pure stdout: no [stderr] block (avoid noise) — got: ${JSON.stringify(out)}`);
    assert(!/\[exit code:/.test(out),
        `exit 0: no exit-code marker on clean run`);
}

// ── 5. LANG=C.UTF-8 forced in spawn env ────────────────────────────────
{
    const out = await executeBuiltinTool('bash', {
        command: `env | grep -E '^LANG='`,
    }, cwd);
    assert(/^LANG=C\.UTF-8\s*$/m.test(out),
        `locale: LANG=C.UTF-8 visible in env (got: ${JSON.stringify(out)})`);
}

// ── 6. Exit code surfacing — non-zero status ───────────────────────────
{
    const out = await executeBuiltinTool('bash', {
        command: `sh -c 'exit 42'`,
    }, cwd);
    assert(out.includes('42'),
        `exit code: 42 surfaced in formatted output (got: ${JSON.stringify(out)})`);
    assert(/\[exit code:\s*42\]/.test(out),
        `exit code: marker format "[exit code: 42]" present`);
}

// ── 7. Blocked pattern returns refusal, not exit-code noise ────────────
{
    const out = await executeBuiltinTool('bash', {
        command: `rm -rf /`,
    }, cwd);
    assert(out.startsWith('Error:') && /blocked/i.test(out),
        `block: clear refusal message (got: ${JSON.stringify(out)})`);
    assert(!/\[exit code:/.test(out),
        `block: no exit-code marker (pattern was rejected pre-spawn)`);
}

// ── 8. merge_stderr=true legacy flag merges back into stdout ───────────
{
    const out = await executeBuiltinTool('bash', {
        command: `echo out; echo err >&2`,
        merge_stderr: true,
    }, cwd);
    assert(!out.includes('[stderr]'),
        `merge_stderr: no [stderr] block when flag set (got: ${JSON.stringify(out)})`);
    assert(out.includes('out') && out.includes('err'),
        `merge_stderr: both streams present in merged output`);
}

// ── 9. large-file shell probe is blocked with tool guidance ────────────
{
    const root = mkdtempSync(join(tmpdir(), 'trib-bash-large-'));
    const big = join(root, 'big.txt');
    try {
        writeFileSync(big, 'x'.repeat(60 * 1024), 'utf8');
        const out = await executeBuiltinTool('bash', {
            command: `cat ${JSON.stringify(big)}`,
        }, cwd);
        assert(out.startsWith('Error:'), `large-file probe: blocked with Error (got: ${JSON.stringify(out.slice(0, 120))})`);
        assert(out.includes('large-file shell probe blocked'), 'large-file probe: reason included');
        assert(out.includes('`read`') && out.includes('builtin `grep`') && out.includes('`edit`'),
            `large-file probe: remediation hints included (got: ${JSON.stringify(out)})`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const total = passed + failed;
console.log(`\nPASS ${passed}/${total}`);
if (failed > 0) {
    console.error(`\n${failed} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
