/**
 * Test for Phase H — Cache Observability (normalizeUsage)
 *
 * Tests with synthetic raw usage per provider.
 */

// Inline the pure functions (no server boot required)
function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function _empty(provider, observable) {
    return {
        provider,
        cache_hit_tokens: 0,
        cache_write_tokens: 0,
        cache_ttl_tier: null,
        cache_hit_ratio: null,
        cache_observable: observable,
    };
}

function _normalizeAnthropic(provider, u) {
    const hit = _num(u.cache_read_input_tokens);
    const write = _num(u.cache_creation_input_tokens);
    const input = _num(u.input_tokens);
    let ttlTier = null;
    if (u.cache_creation) {
        if (_num(u.cache_creation.ephemeral_1h_input_tokens) > 0) ttlTier = '1h';
        else if (_num(u.cache_creation.ephemeral_5m_input_tokens) > 0) ttlTier = '5m';
    }
    const total = hit + input + write;
    const ratio = total > 0 ? hit / total : null;
    return { provider, cache_hit_tokens: hit, cache_write_tokens: write, cache_ttl_tier: ttlTier, cache_hit_ratio: ratio, cache_observable: true };
}

function _normalizeOpenai(provider, u) {
    const hit = _num(u.prompt_tokens_details?.cached_tokens) || _num(u.input_tokens_details?.cached_tokens) || 0;
    const input = _num(u.prompt_tokens) || _num(u.input_tokens) || 0;
    const ratio = input > 0 ? hit / input : null;
    return { provider, cache_hit_tokens: hit, cache_write_tokens: 0, cache_ttl_tier: null, cache_hit_ratio: ratio, cache_observable: true };
}

function _normalizeGemini(provider, u) {
    const meta = u.usageMetadata || u;
    const hit = _num(meta.cachedContentTokenCount);
    const observable = 'cachedContentTokenCount' in (meta || {});
    const input = _num(meta.promptTokenCount) || _num(meta.totalTokenCount) || 0;
    const ratio = input > 0 && hit > 0 ? hit / input : null;
    return { provider, cache_hit_tokens: hit, cache_write_tokens: 0, cache_ttl_tier: null, cache_hit_ratio: ratio, cache_observable: observable };
}

function _normalizeGroq(provider, u) {
    const hit = _num(u.prompt_tokens_cached);
    const observable = 'prompt_tokens_cached' in (u || {});
    const input = _num(u.prompt_tokens) || 0;
    const ratio = input > 0 && hit > 0 ? hit / input : null;
    return { provider, cache_hit_tokens: hit, cache_write_tokens: 0, cache_ttl_tier: null, cache_hit_ratio: ratio, cache_observable: observable };
}

function _normalizeOpenrouter(provider, u) {
    if ('cache_read_input_tokens' in (u || {})) return _normalizeAnthropic(provider, u);
    if ('prompt_tokens_details' in (u || {}) || 'input_tokens_details' in (u || {})) return _normalizeOpenai(provider, u);
    return _empty(provider, false);
}

function normalizeUsage(provider, rawUsage) {
    if (!rawUsage) return _empty(provider, false);
    switch (provider) {
        case 'anthropic': case 'anthropic-oauth': return _normalizeAnthropic(provider, rawUsage);
        case 'openai': case 'openai-oauth': return _normalizeOpenai(provider, rawUsage);
        case 'gemini': return _normalizeGemini(provider, rawUsage);
        case 'groq': return _normalizeGroq(provider, rawUsage);
        case 'openrouter': return _normalizeOpenrouter(provider, rawUsage);
        case 'xai': case 'copilot': case 'ollama': case 'lmstudio': return _empty(provider, false);
        default: return _empty(provider, false);
    }
}

// --- Test helpers ---
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function approx(a, b, eps = 0.001) {
    return Math.abs(a - b) < eps;
}

// =========================================================================
// TEST 1: Anthropic with cache hit
// =========================================================================
console.log('\n=== Test 1: Anthropic ===');
{
    const r = normalizeUsage('anthropic', {
        input_tokens: 1000,
        cache_read_input_tokens: 4722,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 4722 },
    });
    assert(r.provider === 'anthropic', 'provider');
    assert(r.cache_hit_tokens === 4722, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_write_tokens === 500, `write=${r.cache_write_tokens}`);
    assert(r.cache_ttl_tier === '1h', `ttl=${r.cache_ttl_tier}`);
    assert(r.cache_observable === true, 'observable');
    assert(approx(r.cache_hit_ratio, 4722 / (4722 + 1000 + 500)), `ratio=${r.cache_hit_ratio}`);
}

// =========================================================================
// TEST 2: Anthropic 5m tier
// =========================================================================
console.log('\n=== Test 2: Anthropic 5m ===');
{
    const r = normalizeUsage('anthropic-oauth', {
        input_tokens: 200,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 100 },
    });
    assert(r.cache_ttl_tier === '5m', `ttl=${r.cache_ttl_tier}`);
}

// =========================================================================
// TEST 3: OpenAI (prompt_tokens_details)
// =========================================================================
console.log('\n=== Test 3: OpenAI ===');
{
    const r = normalizeUsage('openai', {
        prompt_tokens: 5000,
        prompt_tokens_details: { cached_tokens: 3000 },
    });
    assert(r.cache_hit_tokens === 3000, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_write_tokens === 0, 'write=0');
    assert(approx(r.cache_hit_ratio, 3000 / 5000), `ratio=${r.cache_hit_ratio}`);
    assert(r.cache_observable === true, 'observable');
}

// =========================================================================
// TEST 4: OpenAI OAuth (input_tokens_details)
// =========================================================================
console.log('\n=== Test 4: OpenAI OAuth ===');
{
    const r = normalizeUsage('openai-oauth', {
        input_tokens: 4000,
        input_tokens_details: { cached_tokens: 2000 },
    });
    assert(r.cache_hit_tokens === 2000, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_observable === true, 'observable');
}

// =========================================================================
// TEST 5: Gemini with cache
// =========================================================================
console.log('\n=== Test 5: Gemini ===');
{
    const r = normalizeUsage('gemini', {
        usageMetadata: { cachedContentTokenCount: 1500, promptTokenCount: 3000 },
    });
    assert(r.cache_hit_tokens === 1500, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_observable === true, 'observable');
    assert(approx(r.cache_hit_ratio, 0.5), `ratio=${r.cache_hit_ratio}`);
}

// =========================================================================
// TEST 6: Gemini without cache field
// =========================================================================
console.log('\n=== Test 6: Gemini no cache ===');
{
    const r = normalizeUsage('gemini', {
        usageMetadata: { promptTokenCount: 3000 },
    });
    assert(r.cache_hit_tokens === 0, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_observable === false, 'not observable without field');
}

// =========================================================================
// TEST 7: Groq with cache
// =========================================================================
console.log('\n=== Test 7: Groq ===');
{
    const r = normalizeUsage('groq', {
        prompt_tokens: 2000,
        prompt_tokens_cached: 800,
    });
    assert(r.cache_hit_tokens === 800, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_observable === true, 'observable');
}

// =========================================================================
// TEST 8: OpenRouter → anthropic fields
// =========================================================================
console.log('\n=== Test 8: OpenRouter anthropic ===');
{
    const r = normalizeUsage('openrouter', {
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
    });
    assert(r.cache_hit_tokens === 500, `hit=${r.cache_hit_tokens}`);
    assert(r.cache_observable === true, 'observable');
}

// =========================================================================
// TEST 9: OpenRouter → openai fields
// =========================================================================
console.log('\n=== Test 9: OpenRouter openai ===');
{
    const r = normalizeUsage('openrouter', {
        prompt_tokens: 3000,
        prompt_tokens_details: { cached_tokens: 1000 },
    });
    assert(r.cache_hit_tokens === 1000, `hit=${r.cache_hit_tokens}`);
}

// =========================================================================
// TEST 10: Non-observable providers
// =========================================================================
console.log('\n=== Test 10: Non-observable ===');
for (const p of ['xai', 'copilot', 'ollama', 'lmstudio']) {
    const r = normalizeUsage(p, { some: 'data' });
    assert(r.cache_hit_tokens === 0, `${p} hit=0`);
    assert(r.cache_observable === false, `${p} not observable`);
}

// =========================================================================
// TEST 11: Null rawUsage
// =========================================================================
console.log('\n=== Test 11: Null usage ===');
{
    const r = normalizeUsage('anthropic', null);
    assert(r.cache_hit_tokens === 0, 'null → 0');
    assert(r.cache_observable === false, 'null → not observable');
}

// =========================================================================
// Summary
// =========================================================================
console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
