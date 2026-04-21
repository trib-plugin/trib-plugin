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
import { loadConfig, getPluginData } from './config.mjs';

const DEFAULT_CONFIG = Object.freeze({
    detectThreshold: 4,
    abortThreshold: 5,
    sameToolThresholds: Object.freeze({
        search: 12,
        recall: 12,
        explore: 12,
        web_search: 12,
        memory_search: 12,
        read: 8,
        multi_read: 8,
        grep: 8,
        glob: 8,
        list: 8,
        job_status: 3,
        job_read: 5,
        bash: 10,
        bash_session: 10,
    }),
    toolFamilyWarnRules: Object.freeze([
        Object.freeze({
            key: 'structure_probe',
            threshold: 10,
            minDistinctTools: 2,
            tools: Object.freeze(['read', 'multi_read', 'grep', 'glob', 'list']),
        }),
        Object.freeze({
            key: 'edit_roundtrip',
            threshold: 5,
            minDistinctTools: 2,
            tools: Object.freeze(['edit', 'multi_edit', 'batch_edit', 'edit_lines']),
        }),
        Object.freeze({
            key: 'search_fanout',
            threshold: 10,
            minDistinctTools: 2,
            tools: Object.freeze(['search', 'recall', 'explore', 'web_search', 'memory_search']),
        }),
    ]),
    totalToolWarnThresholds: Object.freeze([24, 48]),
});
let _runtimeConfig = null;
let _loadedRuntimeConfig = null;
let _loadedRuntimeConfigTs = 0;
let _loadedRuntimeConfigKey = '';
const RUNTIME_CONFIG_CACHE_TTL_MS = 60_000;

function buildRuntimeConfig(overrides = {}) {
    return {
        detectThreshold: Number.isFinite(overrides.detectThreshold) ? overrides.detectThreshold : DEFAULT_CONFIG.detectThreshold,
        abortThreshold: Number.isFinite(overrides.abortThreshold) ? overrides.abortThreshold : DEFAULT_CONFIG.abortThreshold,
        sameToolThresholds: new Map(Object.entries({
            ...DEFAULT_CONFIG.sameToolThresholds,
            ...(overrides.sameToolThresholds || {}),
        })),
        toolFamilyWarnRules: (Array.isArray(overrides.toolFamilyWarnRules) ? overrides.toolFamilyWarnRules : DEFAULT_CONFIG.toolFamilyWarnRules)
            .map((rule) => ({
                key: rule.key,
                threshold: rule.threshold,
                minDistinctTools: rule.minDistinctTools,
                tools: new Set(rule.tools),
            })),
        totalToolWarnThresholds: Array.isArray(overrides.totalToolWarnThresholds)
            ? [...overrides.totalToolWarnThresholds]
            : [...DEFAULT_CONFIG.totalToolWarnThresholds],
    };
}

function clearLoadedRuntimeConfigCache() {
    _loadedRuntimeConfig = null;
    _loadedRuntimeConfigTs = 0;
    _loadedRuntimeConfigKey = '';
}

function getLoadedRuntimeConfig() {
    const key = getPluginData();
    const now = Date.now();
    if (_loadedRuntimeConfig && _loadedRuntimeConfigKey === key && now - _loadedRuntimeConfigTs < RUNTIME_CONFIG_CACHE_TTL_MS) {
        return _loadedRuntimeConfig;
    }
    let overrides = {};
    try {
        overrides = loadConfig()?.bridge?.toolLoopGuard || {};
    } catch {
        overrides = {};
    }
    _loadedRuntimeConfig = buildRuntimeConfig(overrides);
    _loadedRuntimeConfigTs = now;
    _loadedRuntimeConfigKey = key;
    return _loadedRuntimeConfig;
}

function getActiveRuntimeConfig() {
    return _runtimeConfig || getLoadedRuntimeConfig();
}

function sameToolThreshold(toolName) {
    return getActiveRuntimeConfig().sameToolThresholds.get(String(toolName || '').toLowerCase()) ?? null;
}

function sameToolThresholdFromConfig(config, toolName) {
    return config.sameToolThresholds.get(String(toolName || '').toLowerCase()) ?? null;
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
    } else if (toolKey === 'job_status') {
        lines.push(`- Prefer \`job_wait\` instead of polling \`job_status\` repeatedly.`);
        lines.push(`- \`job_status\` already includes preview + summary; only \`job_read\` if that summary is insufficient.`);
    } else if (toolKey === 'job_read') {
        lines.push(`- If the job is still running, switch to \`job_wait\` instead of alternating \`job_status\` + \`job_read\`.`);
        lines.push(`- If \`job_status.summary\` already explains the result, stop here instead of reading more log output.`);
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

export function buildToolFamilyWarn(info) {
    const family = String(info?.familyKey || '');
    const count = Number(info?.count || 0);
    const tools = Array.isArray(info?.tools) ? info.tools : [];
    const toolList = tools.length ? tools.map((t) => `\`${t}\``).join(', ') : '`tool`';
    const lines = [
        `⚠ Mixed-tool soft-warn: this session has made ${count} consecutive low-level ${family.replace(/_/g, ' ')} calls across ${toolList}.`,
        `Before issuing another similar tool call, consider switching up a level:`,
    ];
    if (family === 'structure_probe') {
        lines.push(`- If this is about imports, dependents, symbols, references, callers, or impact, prefer \`code_graph\` now instead of another raw \`read\` / \`grep\` / \`glob\` / \`list\` pass.`);
        lines.push(`- If you already have enough scattered hits, synthesize the answer instead of probing a 3rd/4th angle.`);
    } else if (family === 'edit_roundtrip') {
        lines.push(`- Prefer \`apply_patch\` for the next step instead of another \`edit\` / \`multi_edit\` round-trip.`);
        lines.push(`- If the exact change is already clear, emit one multi-file patch and move on.`);
    } else if (family === 'search_fanout') {
        lines.push(`- Batch the next search questions into one call, or synthesize from the evidence you already gathered.`);
        lines.push(`- If the answer is already repo-local, switch from external / memory search back to local tools.`);
    } else {
        lines.push(`- A higher-level tool or a synthesis step will likely yield more than another low-level probe.`);
    }
    lines.push(`(Advisory only — the call is not blocked.)`);
    return lines.join('\n');
}

export function buildToolBudgetWarn(info) {
    const count = Number(info?.count || 0);
    const lines = [
        `⚠ Tool-budget soft-warn: this session has already made ${count} tool calls.`,
        `Before calling another low-level tool, pause and consider:`,
        `- Do you already have enough evidence to synthesize an answer or patch?`,
        `- If not, can you switch up a level: \`code_graph\` for structure, \`apply_patch\` for clear edits, \`bash_session\` for stateful shell work?`,
        `- If you still need another call, make it meaningfully narrower than the previous one.`,
        `(Advisory only — the call is not blocked.)`,
    ];
    return lines.join('\n');
}

/**
 * Create a fresh guard state, one per agent loop / session.
 */
export function createGuard() {
    return {
        config: getActiveRuntimeConfig(),
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
        familyRuns: new Map(),
        totalToolCalls: 0,
        totalToolWarnedThresholds: new Set(),
    };
}

export function setGuardConfigForTesting(overrides = {}) {
    _runtimeConfig = buildRuntimeConfig(overrides);
}

export function resetGuardConfigForTesting() {
    _runtimeConfig = null;
    clearLoadedRuntimeConfigCache();
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
    const cfg = guard?.config || getActiveRuntimeConfig();
    guard.totalToolCalls += 1;

    // ── Same-tool repetition track (independent of error-loop signature).
    // Thresholded whitelist only; non-whitelisted tools also reset the run so an
    // intermixed call sequence breaks the streak.
    let sameToolWarn = null;
    const sameToolWarnThreshold = sameToolThresholdFromConfig(cfg, toolKey);
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

    let familyWarn = null;
    for (const rule of cfg.toolFamilyWarnRules) {
        const prev = guard.familyRuns.get(rule.key) || {
            count: 0,
            distinctTools: new Set(),
            warned: false,
        };
        if (rule.tools.has(toolKey)) {
            prev.count += 1;
            prev.distinctTools.add(toolKey);
            if (!prev.warned
                && prev.count >= rule.threshold
                && prev.distinctTools.size >= rule.minDistinctTools) {
                prev.warned = true;
                familyWarn = {
                    familyKey: rule.key,
                    count: prev.count,
                    tools: [...prev.distinctTools].sort(),
                    text: buildToolFamilyWarn({
                        familyKey: rule.key,
                        count: prev.count,
                        tools: [...prev.distinctTools].sort(),
                    }),
                };
            }
        } else {
            prev.count = 0;
            prev.distinctTools = new Set();
            prev.warned = false;
        }
        guard.familyRuns.set(rule.key, prev);
    }

    let budgetWarn = null;
    for (const threshold of cfg.totalToolWarnThresholds) {
        if (guard.totalToolCalls >= threshold && !guard.totalToolWarnedThresholds.has(threshold)) {
            guard.totalToolWarnedThresholds.add(threshold);
            budgetWarn = {
                count: guard.totalToolCalls,
                threshold,
                text: buildToolBudgetWarn({ count: guard.totalToolCalls, threshold }),
            };
            break;
        }
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
        if (familyWarn) {
            return {
                action: 'family_warn',
                warnText: familyWarn.text,
                info: { familyKey: familyWarn.familyKey, count: familyWarn.count, tools: familyWarn.tools },
            };
        }
        if (budgetWarn) {
            return {
                action: 'budget_warn',
                warnText: budgetWarn.text,
                info: { count: budgetWarn.count, threshold: budgetWarn.threshold },
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

    if (guard.count >= cfg.abortThreshold) {
        return { action: 'abort', info };
    }
    if (guard.count >= cfg.detectThreshold) {
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
    if (familyWarn) {
        return {
            action: 'family_warn',
            warnText: familyWarn.text,
            info: { familyKey: familyWarn.familyKey, count: familyWarn.count, tools: familyWarn.tools },
        };
    }
    if (budgetWarn) {
        return {
            action: 'budget_warn',
            warnText: budgetWarn.text,
            info: { count: budgetWarn.count, threshold: budgetWarn.threshold },
        };
    }
    return { action: 'continue' };
}

// Exposed for tests — internal helpers.
export const DEFAULT_TOOL_LOOP_GUARD_CONFIG = DEFAULT_CONFIG;
export const _internals = {
    normalizeArgs,
    classifyError,
    isErrorResult,
    signatureOf,
    getActiveRuntimeConfig,
    clearLoadedRuntimeConfigCache,
};
