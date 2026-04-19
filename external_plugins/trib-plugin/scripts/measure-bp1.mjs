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

// Keep this in sync with src/agent/orchestrator/session/manager.mjs
// createSession `bridgeDeny` list. Adding / removing tools here without
// updating manager.mjs (or vice versa) will make the bench lie.
const BRIDGE_UNSAFE_TOOLS = new Set([
    // Discord / channel
    'reply', 'react', 'edit_message', 'download_attachment', 'fetch',
    'activate_channel_bridge',
    // Session lifecycle
    'create_session', 'close_session', 'list_sessions', 'list_models',
    // Schedule / config admin
    'schedule_status', 'trigger_schedule', 'schedule_control', 'reload_config',
    // Role delegation
    'bridge',
    // Memory admin (recall stays for reads)
    'memory',
]);

const TOKENS_PER_BYTE = 0.25; // ≈ 4 chars/token for English-ish prose

function bytesToTokens(n) {
    return Math.round(n * TOKENS_PER_BYTE);
}

function measureTools() {
    const tools = require_(join(PLUGIN_ROOT, 'tools.json'));
    const kept = tools.filter(t => !BRIDGE_UNSAFE_TOOLS.has(t.name));
    const stripped = tools.filter(t => BRIDGE_UNSAFE_TOOLS.has(t.name));
    const per = kept.map(t => ({
        name: t.name,
        bytes: JSON.stringify(t).length,
        descBytes: (t.description || '').length,
        schemaBytes: JSON.stringify(t.inputSchema || {}).length,
    }));
    per.sort((a, b) => b.bytes - a.bytes);
    return {
        kept,
        stripped,
        per,
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
        'rules/pool-b/01-agent.md',
        'rules/memory.md',
        'rules/search.md',
        'rules/explore.md',
        'rules/lsp.md',
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

async function main() {
    const args = new Set(process.argv.slice(2));
    const jsonMode = args.has('--json');
    const writeBaseline = args.has('--baseline');
    const compare = args.has('--compare');

    const tools = measureTools();
    const sb = await measureSystemBase();
    const pluginVersion = version();

    const bp1Total = tools.totalBytes + sb.totalBytes;
    const bp1Tokens = bytesToTokens(bp1Total);

    const snapshot = {
        version: pluginVersion,
        measuredAt: new Date().toISOString(),
        tools: { count: tools.kept.length, strippedCount: tools.stripped.length, totalBytes: tools.totalBytes },
        systemBase: { totalBytes: sb.totalBytes, perFile: sb.perFile },
        bp1Total,
        bp1Tokens,
    };

    if (jsonMode) {
        process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
        return;
    }

    const baselinePath = join(PLUGIN_ROOT, '.bp1-baseline.json');

    console.log(`BP1 bench — trib-plugin v${pluginVersion}`);
    console.log('='.repeat(58));
    console.log();
    console.log(`Tools schema (bridge-safe filter applied)`);
    console.log(formatRow('total', tools.totalBytes, `(${tools.kept.length} kept, ${tools.stripped.length} stripped)`));
    console.log(`  top 5 by size:`);
    for (const t of tools.per.slice(0, 5)) {
        console.log(`      ${String(t.bytes).padStart(5)}  ${t.name}  (d=${t.descBytes} s=${t.schemaBytes})`);
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
