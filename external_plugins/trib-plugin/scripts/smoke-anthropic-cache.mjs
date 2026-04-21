#!/usr/bin/env node
/**
 * Smoke test for Anthropic OAuth prompt-cache across iterations with realistic
 * message volumes. Compares msgSlots=1 vs msgSlots=2 so we can decide which BP
 * strategy wins for our real Lead workload.
 *
 * Each variant runs a 10-turn accumulation where each turn asks for a ~100-token
 * answer — this produces the multi-turn BP movement pattern we see in prod.
 * Reports per-iter read / write / input, then per-variant TOTAL cache_write
 * (lower is better — that's what you pay for in new shard bytes).
 */
import { AnthropicOAuthProvider } from '../src/agent/orchestrator/providers/anthropic-oauth.mjs';

if (process.env.CI) {
    console.log('SKIP (CI=1 set, live provider endpoint not available)');
    console.log('PASS 0/0');
    process.exit(0);
}

const MODEL = 'claude-haiku-4-5-20251001';
const ITERS = 10;

const FILLER = Array.from({ length: 80 }, (_, i) =>
    `## Section ${i + 1}\nThis is a stable system-section paragraph used to pad the prompt so the cache breakpoint threshold is exceeded. It contains deterministic lorem-ipsum text: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`
).join('\n\n');

function baseMessages(tag) {
    return [
        { role: 'system', content: `You are a concise assistant (${tag}). Answer with one short sentence. No preamble.\n\n${FILLER}` },
        { role: 'user', content: `<system-reminder>\nVariant: ${tag}\nThis is a stable Tier 3 reminder block used to benchmark prompt caching.\n\n${FILLER}\n</system-reminder>` },
        { role: 'assistant', content: 'Understood. Context absorbed.' },
    ];
}

const QUESTIONS = [
    'Name a primary color.',
    'Name a prime number below 20.',
    'Name a common programming language.',
    'Name a continent.',
    'Name a month of the year.',
    'Name a type of fruit.',
    'Name a musical instrument.',
    'Name a planet.',
    'Name a type of weather.',
    'Name a type of tree.',
];

function fmt(n) { return String(n).padStart(7); }

async function runVariant(tag, slotsCap, provider) {
    process.env.ANTHROPIC_MSG_SLOTS = String(slotsCap);
    const rows = [`\n== msgSlots=${slotsCap} ==`];
    const msgs = [...baseMessages(tag)];
    let totalRead = 0, totalWrite = 0, totalInput = 0;
    for (let i = 1; i <= ITERS; i++) {
        msgs.push({ role: 'user', content: QUESTIONS[i - 1] });
        const res = await provider.send(msgs, MODEL, [], {});
        const u = res.usage?.raw || {};
        const r = u.cache_read_input_tokens || 0;
        const w = u.cache_creation_input_tokens || 0;
        const inp = u.input_tokens || 0;
        totalRead += r; totalWrite += w; totalInput += inp;
        const total = r + w + inp;
        const hr = total > 0 ? (r / total) : 0;
        rows.push(`  iter ${String(i).padStart(2)}: read=${fmt(r)}  write=${fmt(w)}  input=${fmt(inp)}  hr=${hr.toFixed(3)}`);
        msgs.push({ role: 'assistant', content: res.content || '' });
    }
    rows.push(`  TOTAL  : read=${fmt(totalRead)}  write=${fmt(totalWrite)}  input=${fmt(totalInput)}  hr=${(totalRead / (totalRead + totalWrite + totalInput)).toFixed(3)}`);
    return { text: rows.join('\n'), totalWrite, totalRead };
}

async function main() {
    const provider = new AnthropicOAuthProvider({});
    provider.ensureAuth();
    const start = Date.now();
    const r2 = await runVariant('s2', 2, provider);
    console.log(r2.text);
    const r1 = await runVariant('s1', 1, provider);
    console.log(r1.text);
    console.log(`\nTotal ${((Date.now() - start) / 1000).toFixed(1)}s`);
    console.log('\n# Verdict (lower write = better shard reuse)');
    console.log(`  msgSlots=2: total cache_write = ${r2.totalWrite}`);
    console.log(`  msgSlots=1: total cache_write = ${r1.totalWrite}`);
    const winner = r2.totalWrite < r1.totalWrite ? 'msgSlots=2' : r1.totalWrite < r2.totalWrite ? 'msgSlots=1' : 'TIE';
    console.log(`  winner    : ${winner}`);
}

main().catch(err => {
    console.error('SMOKE FAIL:', err.message);
    process.exit(1);
});
