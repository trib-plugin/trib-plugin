#!/usr/bin/env node
/**
 * Burst benchmark — analyze a recent burst of agent calls in a short window.
 *
 * Use case: "I just fired N parallel calls — what was the cache behavior?"
 * Fills a gap left by bench-maintenance-agents.mjs (long-window aggregate)
 * and bench-vs-claude-code.mjs (cross-system) by focusing on the cold→warm
 * transition inside a single short burst.
 *
 * Pulls usage_raw + preset_assign from bridge-trace.jsonl filtered by a
 * recency window (default 5 min) and renders:
 *
 *   - per-call breakdown (call# / role / iter / prompt / cached / cost)
 *   - cold-vs-warm summary (first call of a role = cold, rest = warm)
 *   - aggregate cache hit ratio for the burst
 *
 * Usage:
 *   node scripts/bench-burst.mjs                    # last 5 min default
 *   node scripts/bench-burst.mjs --since=2m         # 2-minute window
 *   node scripts/bench-burst.mjs --since=30s        # 30-second window
 *   node scripts/bench-burst.mjs --role=explorer    # filter to one role
 *   node scripts/bench-burst.mjs --json             # machine-readable
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const COST = { newInput: 1.0, cacheRead: 0.1, cacheWrite: 1.25 };

const args = new Set(process.argv.slice(2).filter(a => !a.includes('=')));
const kv = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.includes('='))
        .map(a => a.replace(/^--/, '').split('=')),
);

function parseDuration(s) {
    const m = String(s || '5m').match(/^(\d+)([smh])$/);
    if (!m) return 5 * 60_000;
    const n = Number(m[1]);
    return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3600_000);
}

const WINDOW_MS = parseDuration(kv.since);
const ROLE_FILTER = kv.role || null;
const JSON_MODE = args.has('--json');

function loadTrace() {
    const p = process.env.TRIB_BRIDGE_TRACE
        || join(process.env.CLAUDE_PLUGIN_DATA
            || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin'),
            'history', 'bridge-trace.jsonl');
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    return text.split('\n').filter(Boolean);
}

function collectBurst(lines) {
    const cutoff = Date.now() - WINDOW_MS;
    const events = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"kind":"preset_assign"') && !line.includes('"kind":"usage_raw"')) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        const ts = new Date(r.ts).getTime();
        if (ts < cutoff) break;
        events.push({ ...r, _ts: ts });
    }
    events.reverse();
    return events;
}

function buildSidRoleMap(events) {
    const map = new Map();
    for (const e of events) {
        if (e.kind !== 'preset_assign' || !e.role) continue;
        if (e.sessionId && e.sessionId !== 'no-session') {
            map.set(e.sessionId, e.role);
        }
    }
    const orphans = events.filter(e =>
        e.kind === 'preset_assign'
        && (!e.sessionId || e.sessionId === 'no-session')
        && e.role);
    const usages = events.filter(e => e.kind === 'usage_raw' && e.sessionId);
    for (const p of orphans) {
        const m = usages.find(u => u._ts >= p._ts && u._ts - p._ts < 5000 && !map.has(u.sessionId));
        if (m) map.set(m.sessionId, p.role);
    }
    return map;
}

function buildSessions(events, sidRole) {
    const bySid = new Map();
    for (const e of events) {
        if (e.kind !== 'usage_raw' || !e.sessionId) continue;
        const role = sidRole.get(e.sessionId) || null;
        if (ROLE_FILTER && role !== ROLE_FILTER) continue;
        const cur = bySid.get(e.sessionId) || {
            sid: e.sessionId, role, firstTs: e._ts, lastTs: e._ts,
            iters: [],
        };
        cur.lastTs = e._ts;
        cur.iters.push({
            iter: e.iteration || cur.iters.length + 1,
            prompt: e.prompt_tokens || 0,
            cached: e.cached_tokens || 0,
            write: e.cache_write_tokens || 0,
            newIn: e.input_tokens || 0,
            output: e.output_tokens || 0,
        });
        bySid.set(e.sessionId, cur);
    }
    const sessions = [...bySid.values()];
    sessions.sort((a, b) => a.firstTs - b.firstTs);
    const seenRole = new Set();
    for (const s of sessions) {
        s.cold = !seenRole.has(s.role);
        seenRole.add(s.role);
        s.totalPrompt = s.iters.reduce((a, x) => a + x.prompt, 0);
        s.totalCached = s.iters.reduce((a, x) => a + x.cached, 0);
        s.totalWrite = s.iters.reduce((a, x) => a + x.write, 0);
        s.totalNew = s.iters.reduce((a, x) => a + x.newIn, 0);
        s.totalOutput = s.iters.reduce((a, x) => a + x.output, 0);
        s.cost = s.totalCached * COST.cacheRead + s.totalNew * COST.newInput + s.totalWrite * COST.cacheWrite;
        s.hitRatio = s.totalPrompt ? s.totalCached / s.totalPrompt : 0;
    }
    return sessions;
}

function fmt(n) { return Math.round(n).toLocaleString(); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

function render(sessions, windowSec) {
    if (!sessions.length) {
        console.log(`No agent calls in last ${windowSec}s${ROLE_FILTER ? ` (role=${ROLE_FILTER})` : ''}.`);
        return;
    }
    console.log(`bench-burst — last ${windowSec}s window (${sessions.length} session(s))`);
    if (ROLE_FILTER) console.log(`role filter: ${ROLE_FILTER}`);
    console.log('─'.repeat(74));
    console.log(' #  cold/warm  role               iter   prompt   cached  hit%    cost  out');
    sessions.forEach((s, i) => {
        const tag = s.cold ? 'COLD' : 'warm';
        const role = (s.role || '?').slice(0, 18).padEnd(18);
        console.log(`${String(i + 1).padStart(2)}  ${tag.padEnd(9)}  ${role} ${String(s.iters.length).padStart(4)}  ${String(fmt(s.totalPrompt)).padStart(7)}  ${String(fmt(s.totalCached)).padStart(7)}  ${pct(s.hitRatio).padStart(5)}  ${String(fmt(s.cost)).padStart(6)}  ${String(fmt(s.totalOutput)).padStart(4)}`);
    });
    console.log();

    const cold = sessions.filter(s => s.cold);
    const warm = sessions.filter(s => !s.cold);
    function agg(group) {
        if (!group.length) return null;
        const p = group.reduce((a, s) => a + s.totalPrompt, 0);
        const c = group.reduce((a, s) => a + s.totalCached, 0);
        const cost = group.reduce((a, s) => a + s.cost, 0);
        const iter = group.reduce((a, s) => a + s.iters.length, 0);
        return {
            sessions: group.length, iter,
            prompt: p, cached: c, hitRatio: p ? c / p : 0,
            cost, costPerIter: iter ? cost / iter : 0,
            costPerSess: cost / group.length,
        };
    }
    const c = agg(cold);
    const w = agg(warm);
    console.log('cold (first per role)  vs  warm (subsequent)');
    console.log('─'.repeat(74));
    if (c) console.log(`  cold:   ${c.sessions} sess  ${c.iter} iter  prompt=${fmt(c.prompt)}  cached=${fmt(c.cached)} (${pct(c.hitRatio)})  cost/sess=${fmt(c.costPerSess)}  cost/iter=${fmt(c.costPerIter)}`);
    if (w) console.log(`  warm:   ${w.sessions} sess  ${w.iter} iter  prompt=${fmt(w.prompt)}  cached=${fmt(w.cached)} (${pct(w.hitRatio)})  cost/sess=${fmt(w.costPerSess)}  cost/iter=${fmt(w.costPerIter)}`);
    if (c && w && c.costPerIter > 0) {
        const speedup = c.costPerIter / w.costPerIter;
        console.log();
        console.log(`  warm cost is ${((1 - w.costPerIter / c.costPerIter) * 100).toFixed(1)}% lower per iter (${speedup.toFixed(2)}x cheaper)`);
    }
    console.log();

    const totalP = sessions.reduce((a, s) => a + s.totalPrompt, 0);
    const totalC = sessions.reduce((a, s) => a + s.totalCached, 0);
    const totalCost = sessions.reduce((a, s) => a + s.cost, 0);
    console.log(`burst total:  prompt=${fmt(totalP)}  cached=${fmt(totalC)} (${pct(totalP ? totalC / totalP : 0)})  cost=${fmt(totalCost)}  no-cache=${fmt(totalP)}  saved=${pct(totalP ? 1 - totalCost / totalP : 0)}`);
}

function main() {
    const lines = loadTrace();
    const events = collectBurst(lines);
    const sidRole = buildSidRoleMap(events);
    const sessions = buildSessions(events, sidRole);

    if (JSON_MODE) {
        const summary = {
            windowMs: WINDOW_MS,
            roleFilter: ROLE_FILTER,
            measuredAt: new Date().toISOString(),
            sessionCount: sessions.length,
            sessions: sessions.map(s => ({
                sid: s.sid, role: s.role, cold: s.cold, iter: s.iters.length,
                prompt: s.totalPrompt, cached: s.totalCached, cost: Math.round(s.cost),
                hitRatio: s.hitRatio,
            })),
        };
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        return;
    }

    render(sessions, Math.round(WINDOW_MS / 1000));
}

main();
