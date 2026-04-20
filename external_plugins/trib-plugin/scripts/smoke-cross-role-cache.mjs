#!/usr/bin/env node
/**
 * Smoke test: 4-BP layout cross-role prompt-cache behaviour.
 *
 * Emits the canonical message shape:
 *   [system: baseRules]    — BP1 1h shared
 *   [system: roleCatalog]  — BP2 1h shared (ALL agent bodies)
 *   [user:   <system-reminder>sessionMarker</system-reminder>]  — BP3 1h per-role
 *   [assistant: 'Session context noted.']
 *   [user:   <system-reminder>volatileTail</system-reminder>]   — BP4-adjacent 5m
 *   [assistant: 'Understood.']
 *   [user:   query]
 *
 * Runs worker→reviewer→tester→worker(repeat). After refactor:
 *   reviewer.cache_read should approach baseRules + roleCatalog size
 *   (≈ BP1+BP2 bytes). Only sessionMarker + query write anew.
 */
import { AnthropicOAuthProvider } from '../src/agent/orchestrator/providers/anthropic-oauth.mjs';
import { composeSystemPrompt } from '../src/agent/orchestrator/context/collect.mjs';

const MODEL = 'claude-haiku-4-5-20251001';

const FILLER = Array.from({ length: 80 }, (_, i) =>
    `## Section ${i + 1}\nThis is a stable system-section paragraph used to pad the prompt so the cache breakpoint threshold is exceeded. It contains deterministic lorem-ipsum text: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`
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
    const { msgs, baseRules, roleCatalog, sessionMarker } = buildMessages(role, permission, query);
    const res = await provider.send(msgs, MODEL, []);
    const u = res.usage?.raw || {};
    const r = u.cache_read_input_tokens || 0;
    const w = u.cache_creation_input_tokens || 0;
    const inp = u.input_tokens || 0;
    const total = r + w + inp;
    const hr = total > 0 ? r / total : 0;
    console.log(`${label.padEnd(16)} read=${fmt(r)}  write=${fmt(w)}  input=${fmt(inp)}  total=${fmt(total)}  hr=${hr.toFixed(3)}`);
    return { r, w, inp, total, baseRules: baseRules.length, roleCatalog: roleCatalog.length, sessionMarker: sessionMarker.length };
}

async function main() {
    const provider = new AnthropicOAuthProvider({});
    provider.ensureAuth();

    console.log('# 4-BP layout smoke — cross-role prompt cache\n');
    const t0 = Date.now();
    const worker   = await callRole(provider, 'worker (warm)', 'worker',   'full',       'Say 1.');
    const reviewer = await callRole(provider, 'reviewer',      'reviewer', 'read',       'Say 2.');
    const tester   = await callRole(provider, 'tester',        'tester',   'read-write', 'Say 3.');
    const worker2  = await callRole(provider, 'worker (again)','worker',   'full',       'Say 4.');

    console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log();
    console.log('# Analysis');
    console.log(`  baseRules + roleCatalog bytes ≈ ${worker.baseRules + worker.roleCatalog}`);
    console.log(`  reviewer read=${reviewer.r}   (expect ≥ baseRules+roleCatalog tokens)`);
    console.log(`  tester   read=${tester.r}`);
    console.log(`  reviewer write=${reviewer.w}  (role-specific only — should be small)`);
    console.log(`  worker(again) hr=${(worker2.r/worker2.total).toFixed(3)}  (self-repeat)`);

    // reviewer.r should cover BP1+BP2 — i.e. roughly equal to worker.w (first-run write)
    // minus the session-marker/query delta that worker also had to write.
    const bp1bp2ratio = worker.w > 0 ? reviewer.r / worker.w : 0;
    console.log(`\n  BP1+BP2 shared ratio (reviewer.read / worker.write): ${bp1bp2ratio.toFixed(3)}`);
    console.log(`  verdict: ${bp1bp2ratio >= 0.9 ? '✓ nearly all shared (BP1+BP2)' : '✗ prefix still fragmented'}`);
}

main().catch(err => {
    console.error('SMOKE FAIL:', err.message);
    process.exit(1);
});
