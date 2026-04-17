// Manual cache verification for cycle1 prompt structure.
// Run from the plugin repo root:
//   CLAUDE_PLUGIN_DATA=<path> node scripts/test-cycle1-cache.mjs

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function main() {
    const { initProviders, getProvider } = await import('../src/agent/orchestrator/providers/registry.mjs');
    const { loadConfig } = await import('../src/agent/orchestrator/config.mjs');

    const config = loadConfig();
    const providersCfg = config.providers || {};
    if (!providersCfg['openai-oauth']?.enabled) {
        console.error('[test] openai-oauth not enabled');
        process.exit(1);
    }
    await initProviders(providersCfg);
    const provider = getProvider('openai-oauth');
    if (!provider) {
        console.error('[test] openai-oauth provider not registered');
        process.exit(1);
    }

    const template = readFileSync(join(ROOT, 'defaults', 'memory-chunk-prompt.md'), 'utf8');
    const dummyEntries = [
        `[1] 2026-04-18T00:00:00Z user: bridge-trace.jsonl usage logging review`,
        `[2] 2026-04-18T00:00:01Z assistant: split usage/usage_raw and drop legacy file`,
        `[3] 2026-04-18T00:00:02Z user: also fix anthropic costUsd=0`,
        `[4] 2026-04-18T00:00:03Z assistant: model-catalog disk fallback added`,
        `[5] 2026-04-18T00:00:04Z user: move cycle1 instruction to prompt head for cache`,
    ].join('\n');
    const prompt = template.replace('{{ENTRIES}}', dummyEntries);

    console.log(`prompt chars=${prompt.length} rough_tokens=${Math.round(prompt.length / 3.5)}`);

    const messages = [{ role: 'user', content: prompt }];
    const model = 'gpt-5.4-mini';

    // Fixed cache key to test whether stable prompt_cache_key enables hits.
    // Use the new promptCacheKey field (sessionId fallback kept for legacy).
    const fixedKey = 'trib:maintenance:cycle1:test';
    for (let i = 1; i <= 2; i++) {
        console.log(`\n--- Call ${i} (promptCacheKey=${fixedKey}) ---`);
        const t0 = Date.now();
        try {
            const r = await provider.send(messages, model, undefined, { promptCacheKey: fixedKey });
            console.log(`duration=${Date.now() - t0}ms`);
            console.log('usage:', JSON.stringify(r.usage || {}));
        } catch (err) {
            console.error('call failed:', err.message);
        }
    }
}

main().catch((err) => {
    console.error('[test] fatal:', err);
    process.exit(1);
});
