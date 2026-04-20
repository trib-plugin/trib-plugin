/**
 * Tests for bridge per-worker git-worktree isolation (v0.6.243).
 *
 * Runs against a disposable fixture repo (mkdtempSync + git init). Never
 * touches the real plugin tree.
 *
 * Test groups (≥ 8 assertions):
 *   1. Happy path: create → worktree exists → branch created → cleanup
 *      removes both.
 *   2. Idempotent re-create: second call with the same sessionId returns
 *      the same path and does NOT error.
 *   3. Cleanup-when-not-found is a no-op.
 *   4. Failure path: runGit throws → createWorkerWorktree falls back,
 *      returns pluginRoot + fallback:true + reason.
 *   5. Orphan sweeper: 2 orphan dirs + 1 live → orphans removed, live
 *      untouched.
 *   6. Cleanup with unpushed commits: WARN logged, still removes.
 *   7. Path safety: sessionIds containing `..`, `/`, `\`, empty string
 *      are rejected by validateSessionId / createWorkerWorktree.
 *   8. Worktree path is always inside `.trib-worktrees/` — never escapes
 *      plugin root.
 */

import {
    createWorkerWorktree,
    cleanupWorkerWorktree,
    listOrphanedWorktrees,
    sweepOrphanedWorktrees,
    validateSessionId,
    worktreePathFor,
} from '../src/agent/bridge-worktree.mjs';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, relative, sep } from 'path';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; }
    else { failed++; console.error(`  FAIL: ${msg}`); }
}

function sh(cmd, cwd) {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true }).toString();
}

function mkFixtureRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'trib-worktree-test-'));
    sh('git init -q', dir);
    sh('git config user.email "t@t.t"', dir);
    sh('git config user.name "t"', dir);
    // Ensure we have a reliable default branch name (git ≥ 2.28 honors
    // init.defaultBranch but older installs yield `master`; harmless here
    // — we use HEAD everywhere).
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    sh('git add README.md', dir);
    sh('git commit -q -m "init"', dir);
    return dir;
}

function cleanup(dir) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
}

function branchExists(dir, branch) {
    try { sh(`git rev-parse --verify --quiet refs/heads/${branch}`, dir); return true; }
    catch { return false; }
}

function mkSilentLog() {
    const lines = [];
    return { fn: (m) => lines.push(m), lines };
}

// ── 1. Happy path ────────────────────────────────────────────────────
{
    const root = mkFixtureRepo();
    try {
        const log = mkSilentLog();
        const res = createWorkerWorktree('sess_happy_001', root, { log: log.fn });
        assert(res.fallback === false, `happy: fallback=false (got ${JSON.stringify(res)})`);
        assert(existsSync(res.path), 'happy: worktree dir exists on disk');
        assert(existsSync(join(res.path, 'README.md')), 'happy: worktree has checkout of HEAD');
        assert(branchExists(root, res.branch), `happy: branch ${res.branch} created`);

        const clean = cleanupWorkerWorktree('sess_happy_001', root, { log: log.fn });
        assert(clean.removed === true, 'happy: cleanup removed=true');
        assert(!existsSync(res.path), 'happy: worktree dir gone after cleanup');
        assert(!branchExists(root, res.branch), 'happy: branch gone after cleanup');
    } finally { cleanup(root); }
}

// ── 2. Idempotent re-create ──────────────────────────────────────────
{
    const root = mkFixtureRepo();
    try {
        const log = mkSilentLog();
        const a = createWorkerWorktree('sess_idem_001', root, { log: log.fn });
        const b = createWorkerWorktree('sess_idem_001', root, { log: log.fn });
        assert(a.path === b.path, 'idempotent: same path on both calls');
        assert(b.reused === true, 'idempotent: second call reports reused=true');
        assert(b.fallback === false, 'idempotent: second call is NOT a fallback');
        cleanupWorkerWorktree('sess_idem_001', root);
    } finally { cleanup(root); }
}

// ── 3. Cleanup-when-not-found is a no-op ─────────────────────────────
{
    const root = mkFixtureRepo();
    try {
        const res = cleanupWorkerWorktree('sess_ghost_001', root, { log: () => {} });
        assert(res.removed === false, 'ghost-cleanup: removed=false');
        assert(res.branchDeleted === false, 'ghost-cleanup: branchDeleted=false');
        // Idempotent repeat
        const res2 = cleanupWorkerWorktree('sess_ghost_001', root, { log: () => {} });
        assert(res2.removed === false, 'ghost-cleanup second: still a clean no-op');
    } finally { cleanup(root); }
}

// ── 4. Failure path: runGit throws → fallback ────────────────────────
{
    const root = mkFixtureRepo();
    try {
        const log = mkSilentLog();
        const brokenRunGit = (args) => {
            // Let diagnostic pre-flight succeed, fail on the actual add.
            if (args[0] === 'worktree' && args[1] === 'add') {
                const err = new Error('simulated disk full');
                err.stderr = 'fatal: cannot mkdir';
                throw err;
            }
            return execSync(`git ${args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`, {
                cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true,
            }).toString();
        };
        const res = createWorkerWorktree('sess_fail_001', root, { runGit: brokenRunGit, log: log.fn });
        assert(res.fallback === true, `failure: fallback=true (got ${JSON.stringify(res)})`);
        assert(res.path === root, 'failure: path falls back to pluginRoot');
        assert(res.branch === null, 'failure: branch=null on fallback');
        assert(typeof res.reason === 'string' && /worktree add failed/.test(res.reason),
            `failure: reason mentions git worktree add (got: ${res.reason})`);
        const joined = log.lines.join('\n');
        assert(/worktree unavailable, running in shared mode/.test(joined),
            `failure: stderr line emitted (got: ${JSON.stringify(joined)})`);
    } finally { cleanup(root); }
}

// ── 5. Orphan sweeper ────────────────────────────────────────────────
{
    const root = mkFixtureRepo();
    try {
        createWorkerWorktree('sess_orphan_a', root, { log: () => {} });
        createWorkerWorktree('sess_orphan_b', root, { log: () => {} });
        createWorkerWorktree('sess_live_c', root, { log: () => {} });

        const live = new Set(['sess_live_c']);
        const orphans = listOrphanedWorktrees(root, live);
        assert(orphans.length === 2, `sweeper: 2 orphans identified (got ${orphans.length}: ${orphans.join(',')})`);
        assert(orphans.includes('sess_orphan_a') && orphans.includes('sess_orphan_b'),
            'sweeper: orphan ids match expected');
        assert(!orphans.includes('sess_live_c'), 'sweeper: live session NOT in orphan list');

        const res = sweepOrphanedWorktrees(root, live, { log: () => {} });
        assert(res.cleaned.length === 2, `sweeper: 2 cleaned (got ${res.cleaned.length})`);
        assert(!existsSync(join(root, '.trib-worktrees', 'sess_orphan_a')),
            'sweeper: orphan_a dir removed');
        assert(!existsSync(join(root, '.trib-worktrees', 'sess_orphan_b')),
            'sweeper: orphan_b dir removed');
        assert(existsSync(join(root, '.trib-worktrees', 'sess_live_c')),
            'sweeper: live_c dir preserved');

        cleanupWorkerWorktree('sess_live_c', root);
    } finally { cleanup(root); }
}

// ── 6. Cleanup with unpushed commits — WARN logged, proceeds ────────
{
    const root = mkFixtureRepo();
    try {
        const log = mkSilentLog();
        const res = createWorkerWorktree('sess_ahead_001', root, { log: log.fn });
        assert(res.fallback === false, 'unpushed: setup succeeds');

        // Commit something inside the worktree — branch is now ahead.
        writeFileSync(join(res.path, 'file-from-worker.txt'), 'hello\n');
        sh('git add file-from-worker.txt', res.path);
        sh('git commit -q -m "worker commit"', res.path);

        const clean = cleanupWorkerWorktree('sess_ahead_001', root, { log: log.fn });
        assert(clean.removed === true, 'unpushed: cleanup still removed the worktree');
        const joined = log.lines.join('\n');
        assert(/WARN branch .* has 1 unpushed commit/.test(joined),
            `unpushed: WARN log emitted (got: ${JSON.stringify(joined)})`);
        assert(!branchExists(root, res.branch), 'unpushed: force-delete branch succeeded');
    } finally { cleanup(root); }
}

// ── 7. Path safety: unsafe sessionIds are rejected ───────────────────
{
    const root = mkFixtureRepo();
    try {
        const bad = ['../escape', 'with/slash', 'with\\backslash', '', '..', 'has space', 'a', 'ok/../evil'];
        for (const b of bad) {
            assert(validateSessionId(b) !== null, `path-safety: validateSessionId rejects ${JSON.stringify(b)}`);
        }
        let threw = false;
        try { createWorkerWorktree('../evil', root, { log: () => {} }); }
        catch (e) { threw = /unsafe|escape|separator/i.test(e.message); }
        assert(threw, 'path-safety: createWorkerWorktree throws on "../evil"');

        let threw2 = false;
        try { worktreePathFor(root, 'evil/../../../etc/passwd'); }
        catch (e) { threw2 = true; }
        assert(threw2, 'path-safety: worktreePathFor rejects traversal sessionId');

        // Good ids accepted
        assert(validateSessionId('sess_42_1700000000000') === null,
            'path-safety: canonical session id accepted');
    } finally { cleanup(root); }
}

// ── 8. Worktree path is always inside .trib-worktrees/ ───────────────
{
    const root = mkFixtureRepo();
    try {
        const res = createWorkerWorktree('sess_scope_001', root, { log: () => {} });
        assert(res.fallback === false, 'scope: create succeeds');
        const rel = relative(resolve(root), resolve(res.path));
        assert(!rel.startsWith('..'), `scope: worktree stays inside root (rel=${rel})`);
        assert(rel.split(sep)[0] === '.trib-worktrees',
            `scope: first path segment is .trib-worktrees (got: ${rel})`);
        assert(rel.split(sep)[1] === 'sess_scope_001',
            `scope: second segment is sessionId (got: ${rel})`);
        cleanupWorkerWorktree('sess_scope_001', root);
    } finally { cleanup(root); }
}

// ── 9. Diagnostic guard: detached HEAD → fallback ────────────────────
{
    const root = mkFixtureRepo();
    try {
        // Detach HEAD by checking out the commit SHA directly.
        const sha = sh('git rev-parse HEAD', root).trim();
        sh(`git checkout -q ${sha}`, root);
        const log = mkSilentLog();
        const res = createWorkerWorktree('sess_detached_001', root, { log: log.fn });
        assert(res.fallback === true, 'detached-HEAD: fallback=true');
        assert(res.path === root, 'detached-HEAD: path falls back to root');
        const joined = log.lines.join('\n');
        assert(/detached HEAD|worktree unavailable/.test(joined),
            `detached-HEAD: fallback message emitted (got: ${JSON.stringify(joined)})`);
    } finally { cleanup(root); }
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
