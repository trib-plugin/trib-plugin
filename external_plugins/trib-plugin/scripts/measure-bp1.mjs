#!/usr/bin/env node
/**
 * BP1 cache-prefix size benchmark for bridge (Pool B / C) sessions.
 *
 * Simulates what a bridge-safe session sees and reports the cached
 * prefix byte / token footprint, broken down by component.
 *
 * Usage:
 *   node scripts/measure-bp1.mjs
 *   node scripts/measure-bp1.mjs --json       # JSON output for scripting
 *   node scripts/measure-bp1.mjs --baseline  # write snapshot to .bp1-baseline.json
 *   node scripts/measure-bp1.mjs --compare   # diff against .bp1-baseline.json
 *   node scripts/measure-bp1.mjs --compare-trace   # print measured vs estimate from bridge-trace.jsonl
 *
 * Token estimates use the 4-chars-per-token heuristic. Actual tokenizer
 * counts differ by ±10%; use this for relative comparison, not billing.
 */

import { readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const require_ = createRequire(import.meta.url);

// Single source of truth — import BRIDGE_DENY_TOOLS from the runtime module
// (src/agent/orchestrator/session/manager.mjs) so this bench cannot drift
// from what createSession actually strips. Resolved lazily inside main().
let BRIDGE_UNSAFE_TOOLS = null;
let SYNTHETIC_DEFS = null;
let SKILL_DEFS = null;

async function loadBridgeUnsafe() {
    if (BRIDGE_UNSAFE_TOOLS) return BRIDGE_UNSAFE_TOOLS;
    const modPath = join(PLUGIN_ROOT, 'src', 'agent', 'orchestrator', 'session', 'manager.mjs');
    const mod = await import(pathToFileURL(modPath).href);
    if (!Array.isArray(mod.BRIDGE_DENY_TOOLS)) {
        throw new Error('manager.mjs does not export BRIDGE_DENY_TOOLS');
    }
    BRIDGE_UNSAFE_TOOLS = new Set(mod.BRIDGE_DENY_TOOLS);
    return BRIDGE_UNSAFE_TOOLS;
}

async function loadSyntheticDefs() {
    if (SYNTHETIC_DEFS) return SYNTHETIC_DEFS;
    const modPath = join(PLUGIN_ROOT, 'src', 'agent', 'orchestrator', 'synthetic-tools.mjs');
    const mod = await import(pathToFileURL(modPath).href);
    if (!Array.isArray(mod.SYNTHETIC_TOOL_DEFS)) {
        throw new Error('synthetic-tools.mjs does not export SYNTHETIC_TOOL_DEFS');
    }
    SYNTHETIC_DEFS = mod.SYNTHETIC_TOOL_DEFS;
    return SYNTHETIC_DEFS;
}

async function loadSkillDefs() {
    if (SKILL_DEFS) return SKILL_DEFS;
    const modPath = join(PLUGIN_ROOT, 'src', 'agent', 'orchestrator', 'context', 'collect.mjs');
    const mod = await import(pathToFileURL(modPath).href);
    if (typeof mod.buildSkillToolDefs !== 'function') {
        throw new Error('collect.mjs does not export buildSkillToolDefs');
    }
    // Pass a non-empty placeholder so the 3 skill meta tools emit; runtime
    // behaviour only gates on `skills.length > 0`.
    SKILL_DEFS = mod.buildSkillToolDefs([{ name: '__measure-bp1-placeholder' }]);
    return SKILL_DEFS;
}

const TOKENS_PER_BYTE = 0.25; // ≈ 4 chars/token for English-ish prose

function bytesToTokens(n) {
    return Math.round(n * TOKENS_PER_BYTE);
}

async function measureTools() {
    const deny = await loadBridgeUnsafe();
    const publicTools = require_(join(PLUGIN_ROOT, 'tools.json'));
    const synthetic = await loadSyntheticDefs();
    const skillTools = await loadSkillDefs();

    // Runtime bridge session composes:
    //   (1) public tools.json minus BRIDGE_DENY_TOOLS
    //   (2) synthetic internal tools (memory_search, web_search) — registered
    //       via server.mjs addInternalTools at boot, not in tools.json
    //   (3) skill meta tools (skills_list / skill_view / skill_execute) —
    //       emitted by buildSkillToolDefs whenever any skill is registered
    // Measuring only (1) used to under-report BP_1 by ~1k tokens; this pass
    // mirrors the real session.tools array.
    const publicKept = publicTools.filter(t => !deny.has(t.name));
    const stripped = publicTools.filter(t => deny.has(t.name));
    const allKept = [...publicKept, ...synthetic, ...skillTools];
    const per = allKept.map(t => ({
        name: t.name,
        source: publicKept.includes(t)
            ? 'public'
            : (synthetic.includes(t) ? 'synthetic' : 'skill'),
        bytes: JSON.stringify(t).length,
        descBytes: (t.description || '').length,
        schemaBytes: JSON.stringify(t.inputSchema || {}).length,
    }));
    per.sort((a, b) => b.bytes - a.bytes);
    return {
        kept: allKept,
        stripped,
        per,
        publicCount: publicKept.length,
        syntheticCount: synthetic.length,
        skillCount: skillTools.length,
        totalBytes: per.reduce((a, b) => a + b.bytes, 0),
    };
}

async function measureSystemBase() {
    const rb = require_(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
    const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
        || join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
    const content = rb.buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR });

    // Per-rule-file sizes for drill-down
    const files = [
        'rules/shared/01-tool.md',
        'rules/shared/02-memory.md',
        'rules/shared/03-search.md',
        'rules/shared/04-explore.md',
        'rules/bridge/00-common.md',
    ];
    const perFile = files.map(f => {
        const p = join(PLUGIN_ROOT, f);
        return { path: f, bytes: existsSync(p) ? statSync(p).size : 0 };
    });
    return { totalBytes: content.length, perFile };
}

function version() {
    try {
        return require_(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')).version;
    } catch {
        return 'unknown';
    }
}

function formatRow(label, bytes, extra = '') {
    const tokens = bytesToTokens(bytes);
    return `  ${String(bytes).padStart(6)} bytes  ≈ ${String(tokens).padStart(5)} tok  ${label}${extra ? '  ' + extra : ''}`;
}

function resolveDataDir() {
    return process.env.CLAUDE_PLUGIN_DATA
        || join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
}

function loadRecentTraceStats(limit = 50) {
    const DATA_DIR = resolveDataDir();
    const tracePath = join(DATA_DIR, 'history', 'bridge-trace.jsonl');
    if (!existsSync(tracePath)) {
        return { available: false, tracePath, sampled: 0, stats: [] };
    }
    const raw = readFileSync(tracePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // Defensive: usage rows are interleaved with transport/loop rows,
    // so grab the last limit*3 lines before filtering by kind.
    const tailLines = lines.slice(-limit * 3);
    const usageRows = [];
    for (const line of tailLines) {
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            continue;
        }
        if (row && row.kind === 'usage') usageRows.push(row);
    }
    const kept = usageRows.slice(-limit);
    const groups = new Map();
    for (const r of kept) {
        const key = `${r.provider || 'unknown'}::${r.model || 'unknown'}`;
        let g = groups.get(key);
        if (!g) {
            g = {
                provider: r.provider || 'unknown',
                model: r.model || 'unknown',
                count: 0,
                promptSum: 0,
                cacheReadSum: 0,
                cacheWriteSum: 0,
            };
            groups.set(key, g);
        }
        g.count += 1;
        g.promptSum += Number(r.promptTokens) || 0;
        g.cacheReadSum += Number(r.cacheReadTokens) || 0;
        g.cacheWriteSum += Number(r.cacheWriteTokens) || 0;
    }
    const stats = [...groups.values()].map(g => ({
        provider: g.provider,
        model: g.model,
        count: g.count,
        promptAvg: Math.round(g.promptSum / g.count),
        cacheReadAvg: Math.round(g.cacheReadSum / g.count),
        cacheWriteAvg: Math.round(g.cacheWriteSum / g.count),
    })).sort((a, b) => b.count - a.count);
    return { available: true, tracePath, sampled: kept.length, stats };
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const jsonMode = args.has('--json');
    const writeBaseline = args.has('--baseline');
    const compare = args.has('--compare');
    const compareTrace = args.has('--compare-trace');

    const tools = await measureTools();
    const sb = await measureSystemBase();
    const pluginVersion = version();

    const bp1Total = tools.totalBytes + sb.totalBytes;
    const bp1Tokens = bytesToTokens(bp1Total);

    const snapshot = {
        version: pluginVersion,
        measuredAt: new Date().toISOString(),
        tools: {
            count: tools.kept.length,
            publicCount: tools.publicCount,
            syntheticCount: tools.syntheticCount,
            skillCount: tools.skillCount,
            strippedCount: tools.stripped.length,
            totalBytes: tools.totalBytes,
        },
        systemBase: { totalBytes: sb.totalBytes, perFile: sb.perFile },
        bp1Total,
        bp1Tokens,
    };

    if (jsonMode) {
        if (compareTrace) {
            const traceInfo = loadRecentTraceStats();
            snapshot.measuredStats = {
                available: traceInfo.available,
                tracePath: traceInfo.tracePath,
                sampled: traceInfo.sampled,
                rows: traceInfo.stats,
            };
        }
        process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
        return;
    }

    const baselinePath = join(PLUGIN_ROOT, '.bp1-baseline.json');

    console.log(`BP1 bench — trib-plugin v${pluginVersion}`);
    console.log('='.repeat(58));
    console.log();
    console.log(`Tools schema (bridge-safe filter applied)`);
    console.log(formatRow(
        'total',
        tools.totalBytes,
        `(${tools.kept.length} kept = ${tools.publicCount} public + ${tools.syntheticCount} synthetic + ${tools.skillCount} skill, ${tools.stripped.length} stripped)`,
    ));
    console.log(`  top 5 by size:`);
    for (const t of tools.per.slice(0, 5)) {
        console.log(`      ${String(t.bytes).padStart(5)}  ${t.name.padEnd(18)}  [${t.source}]  (d=${t.descBytes} s=${t.schemaBytes})`);
    }
    console.log();
    console.log(`systemBase rules (buildBridgeInjectionContent)`);
    console.log(formatRow('total', sb.totalBytes));
    for (const f of sb.perFile) {
        console.log(`      ${String(f.bytes).padStart(5)}  ${f.path}`);
    }
    console.log();
    console.log(`BP1 cache prefix (tools + systemBase — excluding CLAUDE.md common + tier3 + messages prefix, all shared)`);
    console.log(formatRow('total', bp1Total));
    console.log(`  estimated tokens: ~${bp1Tokens.toLocaleString()}`);

    if (compareTrace) {
        const traceInfo = loadRecentTraceStats();
        console.log();
        if (!traceInfo.available) {
            console.log(`Measured vs Estimate  — bridge-trace.jsonl not found at ${traceInfo.tracePath}`);
        } else if (traceInfo.stats.length === 0) {
            console.log(`Measured vs Estimate  — no recent usage rows`);
        } else {
            const rows = traceInfo.stats;
            const headerKey = 'provider::model';
            const headerSamples = 'samples';
            const headerPrompt = 'prompt(avg)';
            const headerCache = 'cacheRead(avg)';
            const headerDelta = 'Δ vs BP1 estimate';
            const fmtNum = (n) => Number(n).toLocaleString();
            const fmtDelta = (n) => (n >= 0 ? '+' : '-') + Math.abs(n).toLocaleString();
            const keys = rows.map(r => `${r.provider}::${r.model}`);
            const samplesStr = rows.map(r => fmtNum(r.count));
            const promptStr = rows.map(r => fmtNum(r.promptAvg));
            const cacheStr = rows.map(r => fmtNum(r.cacheReadAvg));
            const deltaStr = rows.map(r => fmtDelta(r.promptAvg - bp1Tokens));
            const wKey = Math.max(headerKey.length, ...keys.map(s => s.length));
            const wSamples = Math.max(headerSamples.length, ...samplesStr.map(s => s.length));
            const wPrompt = Math.max(headerPrompt.length, ...promptStr.map(s => s.length));
            const wCache = Math.max(headerCache.length, ...cacheStr.map(s => s.length));
            const wDelta = Math.max(headerDelta.length, ...deltaStr.map(s => s.length));
            console.log(`Measured vs Estimate  (last N usage rows from bridge-trace.jsonl, N=${traceInfo.sampled})`);
            console.log(
                '  '
                + headerKey.padEnd(wKey) + '   '
                + headerSamples.padStart(wSamples) + '   '
                + headerPrompt.padStart(wPrompt) + '   '
                + headerCache.padStart(wCache) + '   '
                + headerDelta.padStart(wDelta),
            );
            for (let i = 0; i < rows.length; i++) {
                console.log(
                    '  '
                    + keys[i].padEnd(wKey) + '   '
                    + samplesStr[i].padStart(wSamples) + '   '
                    + promptStr[i].padStart(wPrompt) + '   '
                    + cacheStr[i].padStart(wCache) + '   '
                    + deltaStr[i].padStart(wDelta),
                );
            }
        }
    }

    if (compare && existsSync(baselinePath)) {
        const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
        const deltaBytes = bp1Total - base.bp1Total;
        const deltaTokens = bp1Tokens - base.bp1Tokens;
        const sign = deltaBytes >= 0 ? '+' : '';
        console.log();
        console.log(`Compare vs baseline (v${base.version}, ${base.measuredAt})`);
        console.log(`  total     ${sign}${deltaBytes} bytes  (${sign}${deltaTokens} tokens)`);
        console.log(`  tools     ${tools.totalBytes - base.tools.totalBytes >= 0 ? '+' : ''}${tools.totalBytes - base.tools.totalBytes} bytes`);
        console.log(`  rules     ${sb.totalBytes - base.systemBase.totalBytes >= 0 ? '+' : ''}${sb.totalBytes - base.systemBase.totalBytes} bytes`);
    }

    if (writeBaseline) {
        writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + '\n');
        console.log();
        console.log(`Baseline snapshot written: ${baselinePath}`);
    }
}

main().catch(err => {
    process.stderr.write(`[measure-bp1] ${err?.stack || err}\n`);
    process.exit(1);
});
