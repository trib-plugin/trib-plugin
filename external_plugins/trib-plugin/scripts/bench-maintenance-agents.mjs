#!/usr/bin/env node
/**
 * Benchmark — the three maintenance / proactive agents.
 *
 * Focused on roles that run on a schedule (cycle1 / cycle2 / proactive-decision).
 * Reports per-role session stats from the bridge-trace so prompt shrinks,
 * logic changes, or preset swaps can be tracked version-to-version.
 *
 * Metrics per role:
 *   - sessions, total iter
 *   - median / avg prompt tokens per iter
 *   - median / avg cached tokens per iter
 *   - cache hit ratio
 *   - median / avg cumulative cache_read per session
 *   - session cost (equivalent tokens)
 *   - JSON parse success rate (best-effort, via presence of "{" in result size indicator)
 *
 * Cost model: cached × 0.1 + new × 1.0 + cache_write × 1.25.
 *
 * Usage:
 *   node scripts/bench-maintenance-agents.mjs
 *   node scripts/bench-maintenance-agents.mjs --json
 *   node scripts/bench-maintenance-agents.mjs --baseline
 *   node scripts/bench-maintenance-agents.mjs --compare
 *   node scripts/bench-maintenance-agents.mjs --window=4000
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const BASELINE_PATH = join(PLUGIN_ROOT, '.bench-maintenance-baseline.json');

const TARGET_ROLES = ['cycle1-agent', 'cycle2-agent', 'proactive-decision'];

const COST = { newInput: 1.0, cacheRead: 0.1, cacheWrite: 1.25 };

const args = new Set(process.argv.slice(2).filter(a => !a.includes('=')));
const kv = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.includes('='))
        .map(a => a.replace(/^--/, '').split('=')),
);
const WINDOW = Number.parseInt(kv.window || '4000', 10);

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}
function avg(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function loadTrace() {
    const tracePath = process.env.TRIB_BRIDGE_TRACE
        || join(process.env.CLAUDE_PLUGIN_DATA
            || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin'),
            'history', 'bridge-trace.jsonl');
    if (!existsSync(tracePath)) return { path: tracePath, events: [] };
    const text = readFileSync(tracePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    // Tail scan for window*3 lines (preset_assign + usage_raw density)
    const tail = lines.slice(-WINDOW * 3);
    const events = [];
    for (const l of tail) {
        if (!l.includes('"kind":"preset_assign"') && !l.includes('"kind":"usage_raw"')) continue;
        try {
            const r = JSON.parse(l);
            events.push(r);
        } catch { /* skip */ }
    }
    return { path: tracePath, events };
}

// Map sessionId → role via preset_assign. Also timing-based fallback:
// preset_assign with no sessionId, followed within 5s by a usage_raw that
// has not been claimed yet. This recovers pre-fix records where
// sessionId was written as 'no-session'.
function buildSidRoleMap(events) {
    const map = new Map();
    events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    for (const e of events) {
        if (e.kind !== 'preset_assign') continue;
        if (!e.role) continue;
        if (e.sessionId && e.sessionId !== 'no-session') {
            map.set(e.sessionId, e.role);
        }
    }
    // Timing-based fallback for orphan preset_assign
    const orphans = events.filter(e =>
        e.kind === 'preset_assign'
        && (!e.sessionId || e.sessionId === 'no-session')
        && e.role);
    const usages = events.filter(e => e.kind === 'usage_raw');
    for (const p of orphans) {
        const pt = new Date(p.ts).getTime();
        const match = usages.find(u => {
            const ut = new Date(u.ts).getTime();
            return ut >= pt && ut - pt < 5000 && u.sessionId && !map.has(u.sessionId);
        });
        if (match) map.set(match.sessionId, p.role);
    }
    return map;
}

function collectByRole(events, sidRole) {
    const out = Object.fromEntries(TARGET_ROLES.map(r => [r, new Map()]));
    for (const e of events) {
        if (e.kind !== 'usage_raw') continue;
        if (!e.sessionId) continue;
        const role = sidRole.get(e.sessionId);
        if (!role || !TARGET_ROLES.includes(role)) continue;
        const sess = out[role].get(e.sessionId) || {
            iter: 0, prompt: 0, cached: 0, write: 0, newIn: 0, output: 0,
            promptList: [], cachedList: [], outputList: [],
        };
        sess.iter = Math.max(sess.iter, e.iteration || sess.iter + 1);
        sess.prompt += e.prompt_tokens || 0;
        sess.cached += e.cached_tokens || 0;
        sess.write += e.cache_write_tokens || 0;
        sess.newIn += e.input_tokens || 0;
        sess.output += e.output_tokens || 0;
        sess.promptList.push(e.prompt_tokens || 0);
        sess.cachedList.push(e.cached_tokens || 0);
        sess.outputList.push(e.output_tokens || 0);
        out[role].set(e.sessionId, sess);
    }
    return out;
}

function statsForRole(sessMap) {
    const sessions = [...sessMap.values()];
    if (!sessions.length) return null;
    const iters = sessions.map(s => s.iter);
    const promptPerIter = sessions.flatMap(s => s.promptList);
    const cachedPerIter = sessions.flatMap(s => s.cachedList);
    const outputPerIter = sessions.flatMap(s => s.outputList);
    const cumCached = sessions.map(s => s.cached);
    const sumPrompt = sessions.reduce((a, s) => a + s.prompt, 0);
    const sumCached = sessions.reduce((a, s) => a + s.cached, 0);
    const costPerSess = sessions.map(s =>
        s.cached * COST.cacheRead + s.newIn * COST.newInput + s.write * COST.cacheWrite,
    );
    // Qualitative signals
    const singleIterCount = sessions.filter(s => s.iter <= 1).length;
    const tinyOutputCount = outputPerIter.filter(o => o > 0 && o < 50).length;
    const largeOutputCount = outputPerIter.filter(o => o > 2000).length;
    return {
        sessions: sessions.length,
        totalIter: iters.reduce((a, b) => a + b, 0),
        medianIter: median(iters),
        avgIter: avg(iters),
        medianPromptPerIter: median(promptPerIter),
        avgPromptPerIter: avg(promptPerIter),
        medianCachedPerIter: median(cachedPerIter),
        hitRatio: sumPrompt ? sumCached / sumPrompt : 0,
        medianCumCached: median(cumCached),
        medianSessCost: median(costPerSess),
        avgSessCost: avg(costPerSess),
        costPerIter: avg(costPerSess) / (avg(iters) || 1),
        // Qualitative
        medianOutput: median(outputPerIter),
        avgOutput: avg(outputPerIter),
        singleIterRatio: singleIterCount / sessions.length,
        tinyOutputRatio: outputPerIter.length ? tinyOutputCount / outputPerIter.length : 0,
        largeOutputRatio: outputPerIter.length ? largeOutputCount / outputPerIter.length : 0,
    };
}

function fmt(n) { return Math.round(n).toLocaleString(); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }
function delta(cur, base, isPct = false) {
    if (base == null) return '';
    const d = cur - base;
    if (Math.abs(d) < 0.01) return '';
    const sign = d >= 0 ? '+' : '';
    return isPct ? ` (${sign}${(d * 100).toFixed(1)}%p)` : ` (${sign}${fmt(d)})`;
}

function pluginVersion() {
    try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; }
    catch { return 'unknown'; }
}

function renderRole(role, s, baseline, extras = {}) {
    console.log(`── ${role} ──`);
    if (!s) { console.log('  (no sessions in window)'); return; }
    const rows = [
        // Quantitative
        ['sessions',               s.sessions,             baseline?.sessions,             fmt],
        ['total iter',             s.totalIter,            baseline?.totalIter,            fmt],
        ['median iter/session',    s.medianIter,           baseline?.medianIter,           fmt],
        ['avg iter/session',       +s.avgIter.toFixed(1),  baseline ? +baseline.avgIter.toFixed(1) : null, fmt],
        ['median prompt/iter',     s.medianPromptPerIter,  baseline?.medianPromptPerIter,  fmt],
        ['median cached/iter',     s.medianCachedPerIter,  baseline?.medianCachedPerIter,  fmt],
        ['cache hit ratio',        s.hitRatio,             baseline?.hitRatio,             pct, true],
        ['median cum cache_read',  s.medianCumCached,      baseline?.medianCumCached,      fmt],
        ['median session cost',    s.medianSessCost,       baseline?.medianSessCost,       fmt],
        ['avg session cost',       s.avgSessCost,          baseline?.avgSessCost,          fmt],
        ['cost per iter',          s.costPerIter,          baseline?.costPerIter,          fmt],
        // Qualitative — output size, iter-1 ratio, tail outliers
        ['median output',          s.medianOutput,         baseline?.medianOutput,         fmt],
        ['avg output',             s.avgOutput,            baseline?.avgOutput,            fmt],
        ['single-iter ratio',      s.singleIterRatio,      baseline?.singleIterRatio,      pct, true],
        ['tiny-output (<50tok) ratio', s.tinyOutputRatio,  baseline?.tinyOutputRatio,      pct, true],
        ['large-output (>2k) ratio',   s.largeOutputRatio, baseline?.largeOutputRatio,     pct, true],
    ];
    for (const [label, v, b, f, isPct] of rows) {
        console.log(`  ${label.padEnd(28)} ${String(f(v)).padStart(12)}${delta(v, b, isPct)}`);
    }
    // Role-specific qualitative notes
    if (role === 'proactive-decision' && extras.proactive) {
        const pr = extras.proactive;
        console.log(`  -- proactive-specific (from schedule.log) --`);
        console.log(`  ${'talk fires'.padEnd(28)} ${String(fmt(pr.talk)).padStart(12)}`);
        console.log(`  ${'skip fires'.padEnd(28)} ${String(fmt(pr.skip)).padStart(12)}`);
        console.log(`  ${'talk ratio'.padEnd(28)} ${String(pct(pr.talkRatio)).padStart(12)}`);
    }
    if ((role === 'cycle1-agent' || role === 'cycle2-agent') && extras.cycleParse) {
        const cp = extras.cycleParse[role];
        if (cp) {
            console.log(`  -- parse quality (from stderr trace / boot.log) --`);
            console.log(`  ${'unparseable responses'.padEnd(28)} ${String(fmt(cp.unparseable)).padStart(12)}`);
        }
    }
    console.log();
}

function readProactiveStats(dataDir) {
    try {
        const log = readFileSync(join(dataDir, 'schedule.log'), 'utf8');
        // Tail last ~500 lines for recency
        const tail = log.split('\n').slice(-500);
        let talk = 0, skip = 0;
        for (const l of tail) {
            if (!l.includes('proactive')) continue;
            if (l.includes('"talk"') || l.includes('proactive: "')) talk++;
            else if (l.toLowerCase().includes('proactive: skip')) skip++;
        }
        const total = talk + skip;
        return { talk, skip, talkRatio: total ? talk / total : 0 };
    } catch { return null; }
}

function readCycleParseStats(dataDir) {
    try {
        const log = readFileSync(join(dataDir, 'boot.log'), 'utf8');
        const tail = log.split('\n').slice(-5000);
        const out = {};
        for (const role of ['cycle1-agent', 'cycle2-agent']) {
            const key = role.replace('-agent', '');
            const matches = tail.filter(l => l.includes(`[${key}] unparseable`)).length;
            out[role] = { unparseable: matches };
        }
        return out;
    } catch { return null; }
}

function main() {
    const jsonMode = args.has('--json');
    const saveBaseline = args.has('--baseline');
    const compare = args.has('--compare');

    const trace = loadTrace();
    const sidRole = buildSidRoleMap(trace.events);
    const byRole = collectByRole(trace.events, sidRole);

    const snapshot = {
        version: pluginVersion(),
        measuredAt: new Date().toISOString(),
        window: WINDOW,
        tracePath: trace.path,
        roles: {},
    };
    for (const r of TARGET_ROLES) {
        snapshot.roles[r] = statsForRole(byRole[r]);
    }

    if (jsonMode) {
        process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
        return;
    }

    const baseline = compare && existsSync(BASELINE_PATH)
        ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
        : null;

    console.log(`bench-maintenance-agents — trib-plugin v${snapshot.version}`);
    console.log(`window=${WINDOW}  measured=${snapshot.measuredAt}`);
    if (baseline) console.log(`compare vs baseline v${baseline.version} (${baseline.measuredAt})`);
    console.log('─'.repeat(58));
    console.log();

    const dataDir = process.env.CLAUDE_PLUGIN_DATA
        || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
    const extras = {
        proactive: readProactiveStats(dataDir),
        cycleParse: readCycleParseStats(dataDir),
    };

    for (const r of TARGET_ROLES) {
        renderRole(r, snapshot.roles[r], baseline?.roles?.[r], extras);
    }

    if (saveBaseline) {
        writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
        console.log(`baseline saved: ${BASELINE_PATH}`);
    }
}

main();
