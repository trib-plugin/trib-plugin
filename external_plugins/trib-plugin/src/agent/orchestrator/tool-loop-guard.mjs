/**
 * Tool loop guard — detects repeated identical failures and aborts.
 *
 * Signature = sha256(toolName + normalizedArgs + errorCategory).
 * 2 consecutive same-signature failures -> 'detected' (telemetry only).
 * 3 consecutive same-signature failures -> 'abort' (throw ToolLoopAbortError).
 * Any success, different tool, or different error category resets the state.
 *
 * No hint injection. No retry logic. The guard only blocks; learning and
 * recovery guidance live elsewhere (auto-skill catalog, retro proposer).
 */
import { createHash } from 'crypto';

const DETECT_THRESHOLD = 2;
const ABORT_THRESHOLD = 3;

const ERROR_RULES = [
    { cat: 'edit-match-fail', test: (t) => t.includes('old_string') && (t.includes('did not match') || t.includes('not found') || t.includes('match')) },
    { cat: 'fs-not-found', test: (t) => t.includes('enoent') || t.includes('no such file') },
    { cat: 'fs-exists', test: (t) => t.includes('eexist') || t.includes('file exists') },
    { cat: 'rate-limit', test: (t) => t.includes('429') || (t.includes('rate') && t.includes('limit')) },
    { cat: 'permission', test: (t) => t.includes('eacces') || t.includes('permission denied') || t.includes('access denied') },
    { cat: 'timeout', test: (t) => t.includes('etimedout') || t.includes('timed out') || t.includes('timeout') },
    { cat: 'conn-refused', test: (t) => t.includes('econnrefused') || t.includes('connection refused') },
    { cat: 'auth', test: (t) => t.includes('unauthorized') || t.includes('401') || t.includes('invalid api key') },
];

export class ToolLoopAbortError extends Error {
    constructor(info) {
        const msg = `tool loop aborted after ${info.attemptCount}x ${info.toolName}:${info.errorCategory}`;
        super(msg);
        this.name = 'ToolLoopAbortError';
        this.info = info;
    }
}

function normalizeArgs(args) {
    if (args === null || args === undefined) return '';
    if (typeof args !== 'object') return String(args);
    try {
        const keys = Object.keys(args).sort();
        const normalized = {};
        for (const k of keys) {
            const v = args[k];
            if (typeof v === 'string') {
                // Collapse whitespace variance that doesn't affect semantics but changes hash.
                normalized[k] = v.replace(/\s+/g, ' ').trim().slice(0, 500);
            } else {
                normalized[k] = v;
            }
        }
        return JSON.stringify(normalized);
    } catch {
        return String(args);
    }
}

function classifyError(errorText) {
    if (!errorText) return 'unknown';
    const lower = String(errorText).toLowerCase();
    for (const rule of ERROR_RULES) {
        if (rule.test(lower)) return rule.cat;
    }
    if (lower.startsWith('error:')) {
        const firstLine = lower.split('\n')[0].slice(0, 80);
        const hash = createHash('sha256').update(firstLine).digest('hex').slice(0, 8);
        return `generic:${hash}`;
    }
    return 'unknown';
}

function isErrorResult(result) {
    if (typeof result !== 'string') return false;
    const lower = result.toLowerCase().trim();
    return lower.startsWith('error:') || lower.startsWith('[error');
}

function signatureOf(toolName, args, errorCategory) {
    const normArgs = normalizeArgs(args);
    return createHash('sha256')
        .update(`${toolName}:${normArgs}:${errorCategory}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Create a fresh guard state, one per agent loop / session.
 */
export function createGuard() {
    return {
        currentSig: null,
        count: 0,
        lastInfo: null,
    };
}

/**
 * Feed a tool call result to the guard and decide the next action.
 *
 * @param {object} guard - state from createGuard()
 * @param {{toolName: string, args: any, result: any, iteration: number}} event
 * @returns {{action: 'continue'|'detected'|'abort', info?: object}}
 */
export function checkToolCall(guard, event) {
    const { toolName, args, result, iteration } = event;

    if (!isErrorResult(result)) {
        // Success resets the guard.
        guard.currentSig = null;
        guard.count = 0;
        guard.lastInfo = null;
        return { action: 'continue' };
    }

    const errorCategory = classifyError(result);
    const signature = signatureOf(toolName, args, errorCategory);

    if (signature === guard.currentSig) {
        guard.count += 1;
    } else {
        guard.currentSig = signature;
        guard.count = 1;
    }

    const argsSample = (() => {
        try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
    })();
    const errorSample = String(result).slice(0, 300);

    const info = {
        signature,
        toolName,
        errorCategory,
        attemptCount: guard.count,
        argsSample,
        errorSample,
        iteration,
    };
    guard.lastInfo = info;

    if (guard.count >= ABORT_THRESHOLD) {
        return { action: 'abort', info };
    }
    if (guard.count >= DETECT_THRESHOLD) {
        return { action: 'detected', info };
    }
    return { action: 'continue' };
}

// Exposed for tests — internal helpers.
export const _internals = { normalizeArgs, classifyError, isErrorResult, signatureOf };
