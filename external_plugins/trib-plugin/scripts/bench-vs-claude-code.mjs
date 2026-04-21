#!/usr/bin/env node
/**
 * Benchmark — trib-plugin 3-tier architecture vs Claude Code 2-tier fork.
 *
 * Pulls recent usage records from both transcript stores, groups by
 * session, and reports session-level metrics that make the three
 * architectural differences visible:
 *
 *   1. iter count per session          (shorter = sub-agent offload working)
 *   2. per-iter cost (equivalent tok)  (fair head-to-head unit)
 *   3. cumulative cache_read / session (long iters inflate this 10%-cost stream)
 *   4. cumulative read cost / session  (= cache_read × 0.1)
 *
 * Sources:
 *   Our bridge workers   : ~/.claude/plugins/data/trib-plugin-trib-plugin/history/bridge-trace.jsonl
 *   Claude Code sub-agent: ~/.claude/projects/<project>/<conv>/subagents/*.jsonl
 *
 * Cost model (equivalent tokens relative to fresh input):
 *   new input        × 1.00
 *   cache_read       × 0.10
 *   cache_write 1h   × 2.00   (Anthropic 1h breakpoint surcharge)
 *   cache_write 5m   × 1.25   (5m breakpoint surcharge)
 *
 * Usage:
 *   node scripts/bench-vs-claude-code.mjs               # summary report
 *   node scripts/bench-vs-claude-code.mjs --json        # machine-readable
 *   node scripts/bench-vs-claude-code.mjs --baseline    # save snapshot to .bench-baseline.json
 *   node scripts/bench-vs-claude-code.mjs --compare     # diff against saved baseline
 *   node scripts/bench-vs-claude-code.mjs --window=500  # limit recent usage records per side (default 2000)
 *
 * Intent: moving baseline over time. Run daily; differences show whether
 * plugin changes (prompt edits, BP shrink, fan-out tweaks) keep compounding
 * or regress toward Claude Code's single-session pattern.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const BASELINE_PATH = join(PLUGIN_ROOT, '.bench-baseline.json');

const COST = {
    newInput: 1.0,
    cacheRead: 0.1,
    cacheWrite1h: 2.0,
    cacheWrite5m: 1.25,
};

const args = new Set(process.argv.slice(2).filter(a => !a.includes('=')));
const kvArgs = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.includes('='))
        .map(a => a.replace(/^--/, '').split('=')),
);
const WINDOW = Number.parseInt(kvArgs.window || '2000', 10);

function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// --- Our side: bridge-trace.jsonl ---

function collectOurs(tracePath, window) {
    if (!existsSync(tracePath)) return { error: `bridge-trace.jsonl not found at ${tracePath}`, sessions: [] };
    const text = readFileSync(tracePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    // scan recent usage_raw entries; walk tail first for efficiency
    const usageLines = [];
    for (let i = lines.length - 1; i >= 0 && usageLines.length < window; i--) {
        if (lines[i].includes('"kind":"usage_raw"')) usageLines.push(lines[i]);
    }
    usageLines.reverse();
    const bySid = new Map();
    for (const l of usageLines) {
        try {
            const r = JSON.parse(l);
            if (!r.sessionId) continue;
            const cur = bySid.get(r.sessionId) || { iter: 0, cached: 0, write: 0, newIn: 0, prompt: 0 };
            cur.iter = Math.max(cur.iter, r.iteration || cur.iter + 1);
            cur.cached += r.cached_tokens || 0;
            cur.write += r.cache_write_tokens || 0;
            cur.newIn += r.input_tokens || 0;
            cur.prompt += r.prompt_tokens || 0;
            bySid.set(r.sessionId, cur);
        } catch { /* skip malformed */ }
    }
    const sessions = [...bySid.values()];
    return { sessions };
}

// --- Claude Code side: subagents/*.jsonl under projects ---

function listSubagentFiles(projectsRoot, window) {
    const files = [];
    if (!existsSync(projectsRoot)) return files;
    const projects = readdirSync(projectsRoot);
    for (const proj of projects) {
        const projDir = join(projectsRoot, proj);
        let stat;
        try { stat = statSync(projDir); } catch { continue; }
        if (!stat.isDirectory()) continue;
        // A) conversation-level subagents/
        try {
            const subs = readdirSync(projDir);
            for (const s of subs) {
                const subPath = join(projDir, s);
                let subStat;
                try { subStat = statSync(subPath); } catch { continue; }
                if (subStat.isDirectory()) {
                    const sadir = join(subPath, 'subagents');
                    if (existsSync(sadir)) {
                        for (const f of readdirSync(sadir)) {
                            if (f.endsWith('.jsonl')) files.push(join(sadir, f));
                        }
                    }
                }
            }
        } catch { /* skip */ }
        // B) project-level subagents/
        const directSub = join(projDir, 'subagents');
        if (existsSync(directSub)) {
            try {
                for (const f of readdirSync(directSub)) {
                    if (f.endsWith('.jsonl')) files.push(join(directSub, f));
                }
            } catch { /* skip */ }
        }
    }
    // Sort by mtime desc, cap to window sessions (each file ≈ one sub session)
    files.sort((a, b) => {
        try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
    });
    return files.slice(0, window);
}

function collectClaude(projectsRoot, window) {
    const files = listSubagentFiles(projectsRoot, window);
    const sessions = [];
    for (const f of files) {
        let text;
        try { text = readFileSync(f, 'utf8'); } catch { continue; }
        const lines = text.split('\n').filter(Boolean);
        const sess = { iter: 0, cached: 0, write1h: 0, write5m: 0, newIn: 0, prompt: 0 };
        for (const l of lines) {
            if (!l.includes('"usage"')) continue;
            try {
                const r = JSON.parse(l);
                const u = r.message?.usage || r.usage;
                if (!u || typeof u.input_tokens !== 'number') continue;
                sess.iter++;
                const read = u.cache_read_input_tokens || 0;
                const c1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
                const c5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
                const inp = u.input_tokens || 0;
                sess.cached += read;
                sess.write1h += c1h;
                sess.write5m += c5m;
                sess.newIn += inp;
                sess.prompt += read + c1h + c5m + inp;
            } catch { /* skip */ }
        }
        if (sess.iter > 0) sessions.push(sess);
    }
    return { sessions, fileCount: files.length };
}

// --- Stats ---

function statsForOurs(sessions) {
    if (!sessions.length) return null;
    const iters = sessions.map(s => s.iter);
    const cached = sessions.map(s => s.cached);
    const costs = sessions.map(s => s.cached * COST.cacheRead + s.newIn * COST.newInput + s.write * COST.cacheWrite5m);
    // Our trace lumps writes as 5m-ish (stable cache is 1h-tagged but we don't break it down in trace).
    // Using 5m rate is slightly conservative vs reality; good-enough proxy.
    return {
        sessions: sessions.length,
        totalIter: iters.reduce((a, b) => a + b, 0),
        medianIter: median(iters),
        avgIter: avg(iters),
        medianCumCached: median(cached),
        avgCumCached: avg(cached),
        medianSessCost: median(costs),
        avgSessCost: avg(costs),
        costPerIter: avg(costs) / (avg(iters) || 1),
        p90CumCached: pct(cached, 0.9),
    };
}

function statsForClaude(sessions) {
    if (!sessions.length) return null;
    const iters = sessions.map(s => s.iter);
    const cached = sessions.map(s => s.cached);
    const costs = sessions.map(s =>
        s.cached * COST.cacheRead + s.newIn * COST.newInput
        + s.write1h * COST.cacheWrite1h + s.write5m * COST.cacheWrite5m,
    );
    return {
        sessions: sessions.length,
        totalIter: iters.reduce((a, b) => a + b, 0),
        medianIter: median(iters),
        avgIter: avg(iters),
        medianCumCached: median(cached),
        avgCumCached: avg(cached),
        medianSessCost: median(costs),
        avgSessCost: avg(costs),
        costPerIter: avg(costs) / (avg(iters) || 1),
        p90CumCached: pct(cached, 0.9),
    };
}

// --- Report ---

function fmt(n) { return Math.round(n).toLocaleString(); }
function delta(a, b) {
    if (!a || !b) return '';
    const d = a - b;
    const sign = d >= 0 ? '+' : '';
    return ` (${sign}${fmt(d)})`;
}

function pluginVersion() {
    try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; }
    catch { return 'unknown'; }
}

function renderTable(label, s, baseline) {
    console.log(`${label}`);
    console.log('─'.repeat(58));
    if (!s) { console.log('  (no data)'); return; }
    const rows = [
        ['sessions',            s.sessions,        baseline?.sessions],
        ['total iter',          s.totalIter,       baseline?.totalIter],
        ['median iter/session', s.medianIter,      baseline?.medianIter],
        ['avg iter/session',    Math.round(s.avgIter * 10) / 10, baseline ? Math.round(baseline.avgIter * 10) / 10 : undefined],
        ['median cum cache_read', s.medianCumCached, baseline?.medianCumCached],
        ['p90 cum cache_read',    s.p90CumCached,    baseline?.p90CumCached],
        ['median session cost',   s.medianSessCost,  baseline?.medianSessCost],
        ['avg session cost',      s.avgSessCost,     baseline?.avgSessCost],
        ['cost per iter',         Math.round(s.costPerIter),  baseline ? Math.round(baseline.costPerIter) : undefined],
    ];
    for (const [k, v, b] of rows) {
        const d = (b != null) ? delta(v, b) : '';
        console.log(`  ${k.padEnd(24)} ${String(fmt(v)).padStart(14)}${d}`);
    }
}

function main() {
    const json = args.has('--json');
    const saveBaseline = args.has('--baseline');
    const compare = args.has('--compare');

    const ourTrace = process.env.TRIB_BRIDGE_TRACE
        || join(process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin'), 'history', 'bridge-trace.jsonl');
    const claudeProjects = process.env.CLAUDE_PROJECTS_ROOT || join(homedir(), '.claude', 'projects');

    const oursRaw = collectOurs(ourTrace, WINDOW);
    const claudeRaw = collectClaude(claudeProjects, WINDOW);
    const ours = statsForOurs(oursRaw.sessions);
    const claude = statsForClaude(claudeRaw.sessions);

    const snapshot = {
        version: pluginVersion(),
        measuredAt: new Date().toISOString(),
        window: WINDOW,
        ours,
        claude,
    };

    if (json) {
        process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
        return;
    }

    const baseline = compare && existsSync(BASELINE_PATH)
        ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
        : null;

    console.log(`bench-vs-claude-code — trib-plugin v${snapshot.version}`);
    console.log(`window=${WINDOW}  measured=${snapshot.measuredAt}`);
    if (baseline) console.log(`compare vs baseline v${baseline.version} (${baseline.measuredAt})`);
    console.log();

    renderTable('== trib-plugin bridge workers (3-tier) ==', ours, baseline?.ours);
    console.log();
    renderTable('== Claude Code sub-agents (2-tier fork) ==', claude, baseline?.claude);
    console.log();

    // Head-to-head summary: per-iter cost and cum cache_read ratios.
    if (ours && claude) {
        const iterRatio = claude.costPerIter / (ours.costPerIter || 1);
        const cumRatio = claude.medianCumCached / (ours.medianCumCached || 1);
        const sessCostRatio = claude.medianSessCost / (ours.medianSessCost || 1);
        console.log('== Head-to-head (Claude Code / ours) ==');
        console.log('─'.repeat(58));
        console.log(`  cost per iter ratio            ${iterRatio.toFixed(2)}x  (${claude.costPerIter < ours.costPerIter ? 'Claude cheaper' : 'ours cheaper'})`);
        console.log(`  median cum cache_read ratio    ${cumRatio.toFixed(2)}x  (${cumRatio > 1 ? 'ours less' : 'Claude less'})`);
        console.log(`  median session cost ratio      ${sessCostRatio.toFixed(2)}x  (${sessCostRatio > 1 ? 'ours less' : 'Claude less'})`);
        console.log();
        console.log('  note: workload differences (task type, split granularity) are NOT');
        console.log('  controlled here. Use as a moving baseline across versions, not a');
        console.log('  controlled A/B. Ratios > 1x favor the trib-plugin side.');
    }

    if (saveBaseline) {
        writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
        console.log();
        console.log(`baseline saved: ${BASELINE_PATH}`);
    }
}

main();
