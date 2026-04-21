/**
 * Tool loop guard — detects repeated identical failures and aborts.
 *
 * Signature = sha256(toolName + normalizedArgs + errorCategory).
 * 4 consecutive same-signature failures -> 'detected' — telemetry + a
 *   synthetic soft-warn string (see buildSoftWarn) that callers are
 *   expected to PREPEND onto the just-returned tool result. This gives
 *   the model a chance to self-correct before the hard abort.
 * 5 consecutive same-signature failures -> 'abort' (throw ToolLoopAbortError).
 * Any success, different tool, or different error category resets the state.
 *
 * The warn is emitted exactly once per run-up (on the 4th call of a run;
 * if the 5th call differs the counter resets without re-emitting).
 * Recovery guidance lives here as a per-call sidecar — intentionally
 * actionable rather than a standing system-prompt hint.
 */
import { createHash } from 'crypto';

const DETECT_THRESHOLD = 4;
const ABORT_THRESHOLD = 5;

// Same-tool repetition (success or failure). The error-loop signature above
// only catches identical-error reruns; an agent that calls the same tool with
// different args many times in a row never trips it. This second track watches
// the investigative tools that dominate real iter blow-ups and emits a
// soft-warn once when the run-up crosses the per-tool threshold. Soft only —
// never aborts — to avoid becoming the next thing that hangs deep work
// mid-stride.
const SAME_TOOL_WARN_THRESHOLDS = new Map([
    // Search-like tools: expensive mostly in iterations, not local side
    // effects. Keep the threshold relatively high.
    ['search', 12],
    ['recall', 12],
    ['explore', 12],
    ['web_search', 12],
    ['memory_search', 12],
    // Local investigative tools: these are where long worker/debugger runs
    // actually balloon in the trace logs, so warn earlier.
    ['read', 8],
    ['multi_read', 8],
    ['grep', 8],
    ['glob', 8],
    ['list', 8],
    // Shell loops are especially costly because setup/probe commands tend to
    // be re-run with minimal new information each iteration.
    ['bash', 10],
    ['bash_session', 10],
]);

function sameToolThreshold(toolName) {
    return SAME_TOOL_WARN_THRESHOLDS.get(String(toolName || '').toLowerCase()) ?? null;
}

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
 * Build the soft-warn sidecar text for a 'detected' event. Callers should
 * prepend this onto the corresponding tool result so the model sees it
 * while processing that result (not as a standalone message).
 *
 * @param {{toolName: string, signature: string, errorCategory: string}} info
 * @returns {string}
 */
export function buildSoftWarn(info) {
    const sigShort = String(info.signature || '').slice(0, 8) || 'unknown';
    const toolName = info.toolName || 'tool';
    return [
        `⚠ Tool-loop soft-warn: the same \`${toolName}\` call (signature \`${sigShort}\`) has returned the same result/error 4 times in a row. Before calling this again, reconsider whether you need a different approach:`,
        `- Different arguments (broader/narrower pattern, different path, different glob)`,
        `- A different tool (explore instead of grep, read instead of glob, etc.)`,
        `- Accept the current result and move on`,
        `Calling \`${toolName}\` identically a fifth time WILL abort this session.`,
    ].join('\n');
}

/**
 * Build the soft-warn sidecar text for a same-tool run-up. Caller prepends
 * this onto the corresponding tool result so the model reads it inline.
 */
export function buildSameToolWarn(info) {
    const toolName = info.toolName || 'tool';
    const toolKey = String(toolName).toLowerCase();
    const lines = [
        `⚠ Repeated-tool soft-warn: \`${toolName}\` has been called ${info.count} times in this session.`,
        `Before calling \`${toolName}\` again, consider:`,
    ];
    if (toolKey === 'read' || toolKey === 'multi_read') {
        lines.push(`- Batch file paths into one read call (array \`path\`) instead of serial reads.`);
        lines.push(`- If you are still locating the code, use \`grep\` / \`glob\` first; if you already know the hit, use \`offset\` / \`limit\` instead of re-reading whole files.`);
    } else if (toolKey === 'grep') {
        lines.push(`- OR-join multiple patterns / globs in one \`grep\` call instead of serial probes.`);
        lines.push(`- If the exact file is known, switch to \`read\`; if this is a structural/symbol lookup, prefer \`code_graph\`.`);
    } else if (toolKey === 'glob') {
        lines.push(`- Batch patterns in one \`glob\` call, then switch to \`read\` / \`grep\` once you have hits.`);
        lines.push(`- A broader or repeated \`glob\` rarely helps after 2 rounds unless the root path changed.`);
    } else if (toolKey === 'bash') {
        lines.push(`- Combine dependent commands with \`&&\` / \`;\` instead of multiple one-line bash turns.`);
        lines.push(`- If you need shell state across turns (cwd, env, venv), switch to \`bash_session\` instead of replaying setup commands.`);
    } else if (toolKey === 'bash_session') {
        lines.push(`- Reuse one \`session_id\` and run the next meaningful command, not another setup/probe variant of the same step.`);
        lines.push(`- If the shell already told you enough, synthesize the result before issuing another command.`);
    } else if (toolKey === 'search' || toolKey === 'recall' || toolKey === 'explore' || toolKey === 'web_search' || toolKey === 'memory_search') {
        lines.push(`- Batch related queries in one call and narrow by root/site/type before widening again.`);
        lines.push(`- If the first 1-2 rounds grounded the answer, synthesize now instead of probing a third angle.`);
    } else {
        lines.push(`- You likely have enough information already — synthesize and proceed.`);
        lines.push(`- A different tool may yield more (e.g. read for known files, grep for in-file content, code_graph for structure).`);
    }
    lines.push(`- If you DO call again, narrow the next query meaningfully (different angle, narrower scope, different cwd).`);
    lines.push(
        `(Advisory only — the call is not blocked.)`,
    );
    return lines.join('\n');
}

/**
 * Create a fresh guard state, one per agent loop / session.
 */
export function createGuard() {
    return {
        currentSig: null,
        count: 0,
        lastInfo: null,
        warnedSig: null, // last signature we emitted a soft-warn for
        // Same-tool repetition tracking — independent of error-loop sig.
        // Counts EVERY call (success or fail) of a whitelisted tool.
        // Resets when a different tool runs.
        sameToolName: null,
        sameToolCount: 0,
        sameToolWarnedFor: new Set(),
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
    const toolKey = String(toolName || '').toLowerCase();

    // ── Same-tool repetition track (independent of error-loop signature).
    // Thresholded whitelist only; non-whitelisted tools also reset the run so an
    // intermixed call sequence breaks the streak.
    let sameToolWarn = null;
    const sameToolWarnThreshold = sameToolThreshold(toolKey);
    if (sameToolWarnThreshold !== null) {
        if (guard.sameToolName === toolKey) {
            guard.sameToolCount += 1;
        } else {
            guard.sameToolName = toolKey;
            guard.sameToolCount = 1;
        }
        if (guard.sameToolCount >= sameToolWarnThreshold
            && !guard.sameToolWarnedFor.has(toolKey)) {
            guard.sameToolWarnedFor.add(toolKey);
            sameToolWarn = {
                toolName,
                count: guard.sameToolCount,
                text: buildSameToolWarn({ toolName, count: guard.sameToolCount }),
            };
        }
    } else {
        guard.sameToolName = null;
        guard.sameToolCount = 0;
    }

    if (!isErrorResult(result)) {
        // Success resets the error-loop guard (same-tool track stays — it
        // counts both success and failure on whitelisted tools).
        guard.currentSig = null;
        guard.count = 0;
        guard.lastInfo = null;
        guard.warnedSig = null;
        if (sameToolWarn) {
            return {
                action: 'same_tool_warn',
                warnText: sameToolWarn.text,
                info: { toolName: sameToolWarn.toolName, count: sameToolWarn.count },
            };
        }
        return { action: 'continue' };
    }

    const errorCategory = classifyError(result);
    const signature = signatureOf(toolName, args, errorCategory);

    if (signature === guard.currentSig) {
        guard.count += 1;
    } else {
        guard.currentSig = signature;
        guard.count = 1;
        // Any signature change clears the 'already warned' marker so a
        // fresh run-up can re-emit a warn on its own 4th call.
        guard.warnedSig = null;
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
        // Emit the soft-warn sidecar once per run-up. If the signature
        // somehow ticks past the detect threshold more than once for the
        // same run (shouldn't with count->5==abort, but defensive) we
        // don't re-spam the warning.
        const warnText = guard.warnedSig === signature ? null : buildSoftWarn(info);
        guard.warnedSig = signature;
        return { action: 'detected', info, warnText };
    }
    if (sameToolWarn) {
        return {
            action: 'same_tool_warn',
            warnText: sameToolWarn.text,
            info: { toolName: sameToolWarn.toolName, count: sameToolWarn.count },
        };
    }
    return { action: 'continue' };
}

// Exposed for tests — internal helpers.
export const _internals = { normalizeArgs, classifyError, isErrorResult, signatureOf };
