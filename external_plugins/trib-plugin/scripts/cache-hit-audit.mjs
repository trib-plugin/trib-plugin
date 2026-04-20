#!/usr/bin/env node
/**
 * Audit prompt-cache hit ratio across recent bridge-trace.jsonl records.
 *
 * Usage:
 *   node scripts/cache-hit-audit.mjs              # last 2000 lines
 *   node scripts/cache-hit-audit.mjs --lines=5000 # custom window
 *   node scripts/cache-hit-audit.mjs --warn=0.5   # flag sessions below threshold
 *
 * Reads the history file under the plugin data dir, filters
 * `kind === "usage_raw"` records whose `normalized.cache_observable` is true,
 * and groups cache_hit_ratio by provider + model. Prints mean, min/max,
 * sample count, and any sessions below the warn threshold.
 *
 * Non-zero exit if no data found (so it can gate CI / cron checks).
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../src/agent/orchestrator/config.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const LINES = Number(getArg('lines', 2000));
const WARN = Number(getArg('warn', 0.5));

const path = join(getPluginData(), 'history', 'bridge-trace.jsonl');
if (!existsSync(path)) {
    console.error(`bridge-trace.jsonl not found at ${path}`);
    process.exit(1);
}

const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
const tail = raw.slice(-LINES);
const records = [];
for (const line of tail) {
    try {
        const r = JSON.parse(line);
        if (r.kind !== 'usage_raw') continue;
        if (!r.normalized?.cache_observable) continue;
        if (typeof r.normalized.cache_hit_ratio !== 'number') continue;
        records.push(r);
    } catch { /* skip malformed lines */ }
}

if (records.length === 0) {
    console.error(`no observable cache records in last ${LINES} lines`);
    process.exit(1);
}

// Group by provider + model
const groups = new Map();
for (const r of records) {
    const provider = r.normalized.provider || 'unknown';
    const model = r.model || 'unknown';
    const key = `${provider} / ${model}`;
    if (!groups.has(key)) {
        groups.set(key, { count: 0, hrSum: 0, min: 1, max: 0, low: [] });
    }
    const g = groups.get(key);
    g.count++;
    g.hrSum += r.normalized.cache_hit_ratio;
    if (r.normalized.cache_hit_ratio < g.min) g.min = r.normalized.cache_hit_ratio;
    if (r.normalized.cache_hit_ratio > g.max) g.max = r.normalized.cache_hit_ratio;
    if (r.normalized.cache_hit_ratio < WARN) {
        g.low.push({
            sessionId: r.sessionId,
            hr: r.normalized.cache_hit_ratio,
            prompt: r.prompt_tokens,
            cached: r.cached_tokens,
        });
    }
}

// Print report
const sortedKeys = [...groups.keys()].sort();
let totalLow = 0;
console.log(`# Cache hit audit (last ${records.length}/${tail.length} observable records)\n`);
console.log(`Provider / Model`.padEnd(50) + `samples  mean    min    max    <${WARN}`);
console.log('─'.repeat(80));
for (const key of sortedKeys) {
    const g = groups.get(key);
    const mean = (g.hrSum / g.count).toFixed(3);
    const min = g.min.toFixed(3);
    const max = g.max.toFixed(3);
    const lowCount = g.low.length;
    totalLow += lowCount;
    console.log(key.padEnd(50) + `${String(g.count).padStart(7)}  ${mean}  ${min}  ${max}  ${String(lowCount).padStart(5)}`);
}
console.log();

if (totalLow > 0) {
    console.log(`# Sessions below hit-ratio threshold (< ${WARN})`);
    for (const key of sortedKeys) {
        const g = groups.get(key);
        if (g.low.length === 0) continue;
        console.log(`\n${key}:`);
        for (const s of g.low.slice(0, 5)) {
            console.log(`  ${s.sessionId.slice(0, 40).padEnd(42)} hr=${s.hr.toFixed(3)} cached=${s.cached}/${s.prompt}`);
        }
        if (g.low.length > 5) console.log(`  … (+${g.low.length - 5} more)`);
    }
}

// Exit non-zero if any provider averages below the warn threshold
let regressed = false;
for (const g of groups.values()) {
    if (g.count >= 10 && g.hrSum / g.count < WARN) regressed = true;
}
process.exit(regressed ? 1 : 0);
