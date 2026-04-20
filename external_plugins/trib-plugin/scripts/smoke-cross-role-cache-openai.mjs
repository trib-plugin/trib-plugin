#!/usr/bin/env node
/**
 * Cross-role prompt-cache smoke test for openai-oauth (Codex WebSocket).
 * Mirrors smoke-cross-role-cache.mjs but targets GPT-5.4 so we can compare
 * the effect of the 4-BP layout across providers.
 *
 * Codex has no explicit cache_control — it auto-caches 1024+ token prefixes.
 * The 4-BP layout still helps because baseRules + roleCatalog sit at the
 * head of the prompt; cross-role prefix bytes should match up to sessionMarker.
 */
import { OpenAIOAuthProvider } from '../src/agent/orchestrator/providers/openai-oauth.mjs';
import { composeSystemPrompt } from '../src/agent/orchestrator/context/collect.mjs';

const MODEL = 'gpt-5.4';
const CACHE_KEY = 'trib-smoke-' + Date.now();

const FILLER = Array.from({ length: 80 }, (_, i) =>
    `## Section ${i + 1}\nThis is a stable system-section paragraph used to pad the prompt so the cache threshold is exceeded. It contains deterministic lorem-ipsum text: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`
).join('\n\n');

const baseOpts = {
    userPrompt: `# Shared base\nYou are a concise assistant. Answer with one short sentence. No preamble.\n\n${FILLER}`,
    bridgeRules: `# Rules\nFollow instructions exactly.\n\n${FILLER}`,
    hasSkills: false,
    taskBrief: 'Run the smoke test query as directed.',
    projectContext: `# Project\nStable project context for cache smoke.`,
};

function buildMessages(role, permission, query) {
    const { baseRules, roleCatalog, sessionMarker, volatileTail } = composeSystemPrompt({
        ...baseOpts,
        role,
        permission,
    });
    const msgs = [];
    if (baseRules)    msgs.push({ role: 'system', content: baseRules });
    if (roleCatalog)  msgs.push({ role: 'system', content: roleCatalog });
    if (sessionMarker) {
        msgs.push({ role: 'user', content: `<system-reminder>\n${sessionMarker}\n</system-reminder>` });
        msgs.push({ role: 'assistant', content: 'Session context noted.' });
    }
    if (volatileTail) {
        msgs.push({ role: 'user', content: `<system-reminder>\n${volatileTail}\n</system-reminder>` });
        msgs.push({ role: 'assistant', content: 'Understood.' });
    }
    msgs.push({ role: 'user', content: query });
    return { msgs, baseRules, roleCatalog, sessionMarker, volatileTail };
}

function fmt(n) { return String(n).padStart(7); }

async function callRole(provider, label, role, permission, query) {
    const { msgs } = buildMessages(role, permission, query);
    const res = await provider.send(msgs, MODEL, [], {
        promptCacheKey: CACHE_KEY,
        sessionId: `${CACHE_KEY}-${label}`,
        effort: 'low',
    });
    const u = res.usage?.raw || res.usage || {};
    // Codex Responses API places the cached count under input_tokens_details.cached_tokens
    const cached = u.input_tokens_details?.cached_tokens
        ?? u.cache_read_input_tokens
        ?? 0;
    const input = u.input_tokens ?? 0;
    const nonCached = Math.max(0, input - cached);
    const hr = input > 0 ? cached / input : 0;
    console.log(`${label.padEnd(16)} input=${fmt(input)}  cached=${fmt(cached)}  fresh=${fmt(nonCached)}  hr=${hr.toFixed(3)}`);
    return { input, cached, nonCached };
}

async function main() {
    const provider = new OpenAIOAuthProvider({});
    await provider.ensureAuth();

    console.log('# 4-BP layout smoke — cross-role, Codex (gpt-5.4)');
    console.log(`# cacheKey: ${CACHE_KEY}`);
    console.log();
    const t0 = Date.now();
    const worker   = await callRole(provider, 'worker (warm)', 'worker',   'full',       'Say 1.');
    const reviewer = await callRole(provider, 'reviewer',      'reviewer', 'read',       'Say 2.');
    const tester   = await callRole(provider, 'tester',        'tester',   'read-write', 'Say 3.');
    const worker2  = await callRole(provider, 'worker (again)','worker',   'full',       'Say 4.');

    console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log();
    console.log('# Analysis');
    console.log(`  reviewer cached = ${reviewer.cached}  (should cover baseRules + roleCatalog)`);
    console.log(`  tester   cached = ${tester.cached}`);
    console.log(`  worker(again) cached = ${worker2.cached}  hr=${(worker2.cached/worker2.input).toFixed(3)}`);
    console.log(`  verdict: cross-role share? reviewer hr = ${(reviewer.cached/reviewer.input).toFixed(3)}`);
}

main().catch(err => {
    console.error('SMOKE FAIL:', err.message);
    process.exit(1);
});
