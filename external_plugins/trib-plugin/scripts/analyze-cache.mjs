#!/usr/bin/env node
// Phase C Ship 0 — Pool B cache empirical measurement.
//
// Reads <plugin-data>/llm-usage.jsonl and produces per-profile / per-provider
// cache-hit statistics. Use this to validate the Ship 0 assumptions:
//   • Anthropic TTL refresh on hit (same prefixHash reused after 50+ min gap)
//   • OpenAI prompt_cache_key durability (cacheRead persistence across sessions)
//   • Gemini cachedContents applicability (whether cache fields ever populate)
//
// Usage:
//   node scripts/analyze-cache.mjs [path/to/llm-usage.jsonl]
//   node scripts/analyze-cache.mjs --since 24h

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
let sinceMs = null;
let path = null;
for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--since' && args[i + 1]) {
        const spec = args[i + 1];
        const m = spec.match(/^(\d+)([hdm])$/);
        if (m) {
            const n = Number(m[1]);
            const unit = m[2];
            const multiplier = unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : 86_400_000;
            sinceMs = Date.now() - n * multiplier;
        }
        i += 1;
    } else if (!path && !a.startsWith('--')) {
        path = a;
    }
}

path = path || join(
    homedir(),
    '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin', 'llm-usage.jsonl',
);

if (!existsSync(path)) {
    console.error(`Not found: ${path}`);
    process.exit(1);
}

const raw = readFileSync(path, 'utf8').split('\n').filter(Boolean);
const entries = [];
for (const line of raw) {
    try {
        const e = JSON.parse(line);
        if (sinceMs && new Date(e.ts).getTime() < sinceMs) continue;
        entries.push(e);
    } catch { /* skip malformed lines */ }
}

if (entries.length === 0) {
    console.log(`No entries${sinceMs ? ' within window' : ''}.`);
    process.exit(0);
}

const byProfile = new Map();
for (const e of entries) {
    const key = e.profileId || '(no-profile)';
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(e);
}

function sum(items, field) {
    return items.reduce((s, i) => s + (Number(i[field]) || 0), 0);
}

function formatPct(num, den) {
    if (!den) return 'N/A';
    return `${(100 * num / den).toFixed(1)}%`;
}

console.log(`Analyzing ${entries.length} calls from ${path}`);
if (sinceMs) console.log(`Window: since ${new Date(sinceMs).toISOString()}`);
console.log('');

for (const [profileId, items] of byProfile) {
    const totalRead = sum(items, 'cacheReadTokens');
    const totalWrite = sum(items, 'cacheWriteTokens');
    const totalInput = sum(items, 'inputTokens');
    const totalOutput = sum(items, 'outputTokens');
    const prefixHashes = new Set(items.map(i => i.prefixHash).filter(Boolean));
    const providers = new Set(items.map(i => i.provider).filter(Boolean));
    const sessions = new Set(items.map(i => i.sessionId).filter(Boolean));

    console.log(`[${profileId}] calls=${items.length} sessions=${sessions.size} providers=${[...providers].join(',') || '-'}`);
    console.log(`  prefixHashes=${prefixHashes.size}${prefixHashes.size > 0 ? ` (first=${[...prefixHashes][0]})` : ''}`);
    console.log(`  tokens: input=${totalInput} output=${totalOutput}`);
    console.log(`  cache:  read=${totalRead} write=${totalWrite} hitRate=${formatPct(totalRead, totalRead + totalWrite)} readShareOfInput=${formatPct(totalRead, totalInput)}`);

    const byProvider = new Map();
    for (const item of items) {
        const p = item.provider || '-';
        if (!byProvider.has(p)) byProvider.set(p, []);
        byProvider.get(p).push(item);
    }
    for (const [prov, provItems] of byProvider) {
        const r = sum(provItems, 'cacheReadTokens');
        const w = sum(provItems, 'cacheWriteTokens');
        const inp = sum(provItems, 'inputTokens');
        if (byProvider.size > 1 || prov !== '-') {
            console.log(`    ${prov}: calls=${provItems.length} read=${r} write=${w} input=${inp} hitRate=${formatPct(r, r + w)}`);
        }
    }

    const sorted = items.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const gaps = [];
    for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev.prefixHash && prev.prefixHash === cur.prefixHash) {
            const gapMs = new Date(cur.ts).getTime() - new Date(prev.ts).getTime();
            gaps.push({ gapMs, read: cur.cacheReadTokens || 0, write: cur.cacheWriteTokens || 0 });
        }
    }
    if (gaps.length > 0) {
        const longest = gaps.sort((a, b) => b.gapMs - a.gapMs).slice(0, 3);
        console.log(`  reuse gaps (top 3 by duration):`);
        for (const g of longest) {
            const min = (g.gapMs / 60_000).toFixed(1);
            console.log(`    +${min}min: cacheRead=${g.read} cacheWrite=${g.write} (hit=${g.read > 0 && g.write === 0 ? 'yes' : 'no'})`);
        }
    }
    console.log('');
}

const overallRead = sum(entries, 'cacheReadTokens');
const overallWrite = sum(entries, 'cacheWriteTokens');
const overallInput = sum(entries, 'inputTokens');
console.log(`Overall: ${entries.length} calls  input=${overallInput}  cacheRead=${overallRead}  cacheWrite=${overallWrite}  hitRate=${formatPct(overallRead, overallRead + overallWrite)}  readShareOfInput=${formatPct(overallRead, overallInput)}`);
