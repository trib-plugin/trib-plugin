/**
 * Semantic cache (GPTCache-inspired) for deterministic LLM call paths.
 *
 * Scope is strictly allow-listed: `classify`, `core-promote-phase{1,2,3}`,
 * `reason`, `skill-suggest`, `proactive`. Bridge agentLoop / provider send
 * / tool execution are explicitly EXCLUDED — do NOT pass cacheScope for
 * those paths.
 *
 * Storage: single shared `semantic_cache` table in memory.sqlite. Embeddings
 * reuse the existing `embedText()` pipeline to avoid a new dependency.
 */
import { createHash } from 'crypto';
import { getMemoryStore } from '../../memory/lib/memory.mjs';
import { embedText } from '../../memory/lib/embedding-provider.mjs';
import { cosineSimilarity as cosineSimilarityShared } from '../../memory/lib/memory-vector-utils.mjs';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Single-path allow-list. Scope == caller tag. Presence here means "lookup /
// store is attempted for this scope"; absence means cacheScope was passed
// for a scope outside policy and is ignored (defensive).
const SEMANTIC_ELIGIBLE_SCOPES = new Set([
    'classify',
    'core-promote-phase1',
    'core-promote-phase2',
    'core-promote-phase3',
    'reason',
    'skill-suggest',
]);

// Scope tuning: thresholds and exact-only flag are hardcoded. There is no
// runtime toggle — callers either pass cacheScope (and hit this table) or
// they don't (bridge agentLoop, provider send, tool exec by policy).
const SCOPE_TUNING = {
    classify:              { exactOnly: false, threshold: 0.95 },
    'core-promote-phase1': { exactOnly: false, threshold: 0.93 },
    'core-promote-phase2': { exactOnly: false, threshold: 0.93 },
    'core-promote-phase3': { exactOnly: false, threshold: 0.93 },
    reason:                { exactOnly: false, threshold: 0.92 },
    'skill-suggest':       { exactOnly: false, threshold: 0.93 },
    // proactive is categorical — exact hash only, no semantic similarity.
    proactive:             { exactOnly: true },
};

const TTL_DAYS = 30;
const MAX_ENTRIES = 5000;

const PLUGIN_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
const TELEMETRY_PATH = join(PLUGIN_DATA_DIR, 'history', 'semantic-cache.jsonl');

function _appendTelemetry(entry) {
    // Fire-and-forget: never let telemetry errors affect cache behaviour.
    try {
        const dir = dirname(TELEMETRY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(TELEMETRY_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* swallow */ }
}

function _estimateSavedTokens(responseText) {
    if (!responseText) return 0;
    // ~4 chars per token heuristic, consistent with bridge estimators.
    return Math.ceil(String(responseText).length / 4);
}

/**
 * Return scope tuning or `null` when the scope isn't in policy.
 */
function _scopeTuning(scope) {
    return SCOPE_TUNING[scope] || null;
}

/**
 * Collapse trivial whitespace and strip HTML-style internal comments. Stable
 * enough to produce reusable sha256 hashes for prompts that differ only in
 * formatting. Case is preserved because code / paths / names carry meaning.
 */
export function normalizePrompt(prompt) {
    return String(prompt ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('\n')
        .map(line => line.replace(/[\t ]+$/g, ''))
        .join('\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function _sha256(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function _localNow() {
    return new Date().toISOString();
}

function _serializeEmbedding(vec) {
    if (!vec) return null;
    const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
function _deserializeEmbedding(buf) {
    if (!buf) return null;
    const view = buf instanceof Buffer
        ? new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
        : new Float32Array(buf);
    return Float32Array.from(view);
}

/**
 * Single-path lookup. Returns `{ hit, response, similarity? }` on hit, `null`
 * otherwise. The caller decides whether to pass cacheScope — no enable toggle.
 * Scopes outside the hardcoded tuning table are ignored defensively.
 */
export async function semanticCacheLookup(scope, prompt, model) {
    const tuning = _scopeTuning(scope);
    if (!tuning) return null;

    const normalized = normalizePrompt(prompt);
    const hash = _sha256(normalized);
    const store = getMemoryStore(PLUGIN_DATA_DIR);
    const db = store?.db;
    if (!db) return null;

    // Fast path: exact hash match
    const exact = db.prepare(
        `SELECT id, response_text FROM semantic_cache
         WHERE scope=? AND prompt_hash=? AND model=?`
    ).get(scope, hash, model);
    if (exact) {
        db.prepare(
            `UPDATE semantic_cache SET hit_count=hit_count+1, last_hit_at=? WHERE id=?`
        ).run(_localNow(), exact.id);
        _appendTelemetry({
            ts: _localNow(), scope, model,
            hit: 'exact',
            savedTokens: _estimateSavedTokens(exact.response_text),
        });
        return { hit: 'exact', response: exact.response_text };
    }

    // Slow path: embedding similarity (eligible scopes only, not exactOnly)
    if (tuning.exactOnly === true) {
        _appendTelemetry({ ts: _localNow(), scope, model, hit: null });
        return null;
    }
    if (!SEMANTIC_ELIGIBLE_SCOPES.has(scope)) {
        _appendTelemetry({ ts: _localNow(), scope, model, hit: null });
        return null;
    }

    let queryEmbedding;
    try {
        queryEmbedding = await embedText(normalized.slice(0, 2048));
    } catch (err) {
        process.stderr.write(`[semantic-cache] embed lookup failed: ${err?.message || err}\n`);
        _appendTelemetry({ ts: _localNow(), scope, model, hit: null });
        return null;
    }
    if (!queryEmbedding) {
        _appendTelemetry({ ts: _localNow(), scope, model, hit: null });
        return null;
    }

    const candidates = db.prepare(
        `SELECT id, embedding, response_text FROM semantic_cache
         WHERE scope=? AND model=? AND embedding IS NOT NULL
         ORDER BY hit_count DESC, last_hit_at DESC NULLS LAST
         LIMIT 50`
    ).all(scope, model);

    const threshold = Number.isFinite(tuning.threshold) ? tuning.threshold : 0.92;
    let best = null;
    for (const c of candidates) {
        const vec = _deserializeEmbedding(c.embedding);
        if (!vec || vec.length !== queryEmbedding.length) continue;
        const sim = cosineSimilarityShared(queryEmbedding, vec);
        if (sim >= threshold && (!best || sim > best.sim)) {
            best = { sim, id: c.id, response: c.response_text };
        }
    }
    if (best) {
        db.prepare(
            `UPDATE semantic_cache SET hit_count=hit_count+1, last_hit_at=? WHERE id=?`
        ).run(_localNow(), best.id);
        _appendTelemetry({
            ts: _localNow(), scope, model,
            hit: 'semantic',
            similarity: best.sim,
            savedTokens: _estimateSavedTokens(best.response),
        });
        return { hit: 'semantic', similarity: best.sim, response: best.response };
    }
    _appendTelemetry({ ts: _localNow(), scope, model, hit: null });
    return null;
}

export async function semanticCacheStore(scope, prompt, model, response) {
    const tuning = _scopeTuning(scope);
    if (!tuning || !response) return;

    const store = getMemoryStore(PLUGIN_DATA_DIR);
    const db = store?.db;
    if (!db) return;

    const normalized = normalizePrompt(prompt);
    const hash = _sha256(normalized);
    let embeddingBlob = null;
    const semanticEligible = tuning.exactOnly !== true && SEMANTIC_ELIGIBLE_SCOPES.has(scope);
    if (semanticEligible) {
        try {
            const vec = await embedText(normalized.slice(0, 2048));
            embeddingBlob = _serializeEmbedding(vec);
        } catch (err) {
            process.stderr.write(`[semantic-cache] embed store failed: ${err?.message || err}\n`);
        }
    }
    try {
        db.prepare(
            `INSERT INTO semantic_cache
               (scope, prompt_hash, prompt_text, embedding, response_text, model, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope, prompt_hash, model) DO UPDATE SET
               response_text = excluded.response_text,
               embedding = COALESCE(excluded.embedding, semantic_cache.embedding),
               created_at = excluded.created_at`
        ).run(
            scope,
            hash,
            normalized,
            embeddingBlob,
            String(response),
            model,
            _localNow(),
        );
    } catch (err) {
        process.stderr.write(`[semantic-cache] store failed: ${err?.message || err}\n`);
    }
    // LRU capacity trim (hardcoded MAX_ENTRIES).
    try {
        const countRow = db.prepare(`SELECT COUNT(*) AS n FROM semantic_cache`).get();
        const over = (countRow?.n || 0) - MAX_ENTRIES;
        if (over > 0) {
            db.prepare(
                `DELETE FROM semantic_cache
                 WHERE id IN (
                   SELECT id FROM semantic_cache
                   ORDER BY last_hit_at ASC NULLS FIRST, created_at ASC
                   LIMIT ?
                 )`
            ).run(over);
        }
    } catch { /* best effort */ }
}

/**
 * TTL prune. Exposed for cycle2 piggyback — runtime does not call it on
 * every request.
 */
export function semanticCachePrune() {
    const store = getMemoryStore(PLUGIN_DATA_DIR);
    const db = store?.db;
    if (!db) return 0;
    const cutoff = new Date(Date.now() - TTL_DAYS * 86400000).toISOString();
    try {
        const result = db.prepare(
            `DELETE FROM semantic_cache WHERE created_at < ?`
        ).run(cutoff);
        return result?.changes || 0;
    } catch (err) {
        process.stderr.write(`[semantic-cache] prune failed: ${err?.message || err}\n`);
        return 0;
    }
}

export function clearSemanticCache(scope) {
    const store = getMemoryStore(PLUGIN_DATA_DIR);
    const db = store?.db;
    if (!db) return 0;
    try {
        const result = scope
            ? db.prepare(`DELETE FROM semantic_cache WHERE scope = ?`).run(scope)
            : db.prepare(`DELETE FROM semantic_cache`).run();
        return result?.changes || 0;
    } catch (err) {
        process.stderr.write(`[semantic-cache] clear failed: ${err?.message || err}\n`);
        return 0;
    }
}
