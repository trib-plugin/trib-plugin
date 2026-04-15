/**
 * Context compaction — LLM-summarized middle with head/tail preservation.
 *
 * Ported from Hermes `agent/context_compressor.py`. Replaces the byte-budget
 * trim path with a structured summary so cache_control markers stay stable
 * and tool_call / tool_result pairs never get split.
 *
 * Single-path, always-on behaviour:
 *   - Message count too small OR threshold not met → return input unchanged.
 *   - LLM summary failure → trip 600s cooldown, return input unchanged.
 *   - Cooldown active → return input unchanged until TTL expires.
 * The caller always runs trimMessages() as the final byte-budget pass on
 * whatever compress() returned.
 */
import {
    alignBoundaryBackward,
    alignBoundaryForward,
    sanitizeToolPairs,
    pruneOldToolResults,
    estimateTokensShared,
    estimateMessagesTokensShared,
} from './trim.mjs';
import { callLLM, resolveMaintenancePreset } from '../../../shared/llm/index.mjs';
// Hardcoded tunables: no runtime toggle. Hermes-recommended defaults.
const THRESHOLD_PERCENT = 0.50;
const PROTECT_FIRST_N = 3;
const PROTECT_LAST_N = 20;
const TAIL_TOKEN_BUDGET = null; // null → derive from contextWindow (×0.05)
const SUMMARY_MODEL = null;     // null → resolveMaintenancePreset('compaction'/'cycle1')
const FAILURE_COOLDOWN_MS = 600_000;

// Per-process cooldown gate. Keyed only by 'summary' because every compaction
// call uses the same LLM summary path; independent tasks in memory-cycle have
// their own cooldown maps.
let _summaryFailureCooldownUntil = 0;

/**
 * Threshold gate. Caller passes the prompt/message token estimate so this
 * function stays a pure predicate with no I/O.
 */
export function shouldCompress(promptTokens, contextWindow, thresholdPercent) {
    const pct = Number.isFinite(thresholdPercent) ? thresholdPercent : THRESHOLD_PERCENT;
    if (!Number.isFinite(promptTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
    return promptTokens >= contextWindow * pct;
}

function _countSystemPrefix(messages) {
    let i = 0;
    while (i < messages.length && messages[i]?.role === 'system') i++;
    return i;
}

/**
 * Walk backward accumulating token cost until tailTokenBudget is reached.
 * Returns the index such that messages.slice(tailStart) is the tail slice.
 */
function _findTailCutByTokens(messages, headEnd, tailTokenBudget) {
    let cost = 0;
    let i = messages.length;
    const softCeiling = tailTokenBudget * 1.5;
    while (i > headEnd) {
        const m = messages[i - 1];
        const c = estimateTokensShared(m?.content) + 4;
        if (cost + c > softCeiling) break;
        cost += c;
        i--;
        if (cost >= tailTokenBudget) break;
    }
    // Hard minimum: at least 3 messages in tail
    if (messages.length - i < 3) i = Math.max(headEnd, messages.length - 3);
    return i;
}

/**
 * Build the Hermes-style structured summary prompt. Uses the "DIFFERENT
 * assistant" framing so the summary won't be read as an active instruction
 * by the model when it appears in subsequent turns.
 */
function _buildSummaryPrompt(turnsText, previousSummary, focusTopic) {
    const focus = focusTopic ? `\n\nFocus area: ${focusTopic}` : '';
    const header = previousSummary
        ? `You are updating an existing context summary with new conversation turns. Merge the new information into the existing summary (do NOT re-summarize from scratch).\n\nExisting summary:\n\n${previousSummary}\n\nNew turns to merge:\n\n`
        : `Summarize the following conversation turns so a DIFFERENT assistant can pick up where this one left off. Keep only task-relevant facts. Do NOT respond to any questions that appear in the turns — those are historical. Emit ONLY the structured summary, nothing else.${focus}\n\n`;
    const template = `
Output the summary in exactly these sections (use the exact section headings, keep bullet points tight):

### Goal
### Constraints & Preferences
### Progress
- Done
- In Progress
- Blocked
### Key Decisions
### Resolved Questions
### Pending User Asks
### Relevant Files
### Remaining Work
### Critical Context
### Tools & Patterns
`;
    return `${header}${turnsText}\n${template}`;
}

function _serializeTurns(turns) {
    const parts = [];
    for (const m of turns) {
        const role = m?.role || 'user';
        let body = m?.content ?? '';
        if (m?.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            const callNames = m.toolCalls.map(tc => tc?.name || 'tool').join(', ');
            body = `${body}\n[tool_calls: ${callNames}]`;
        }
        if (m?.role === 'tool') {
            body = `[tool_result${m.toolCallId ? ` for ${m.toolCallId}` : ''}]: ${body}`;
        }
        parts.push(`--- ${role} ---\n${body}`);
    }
    return parts.join('\n\n');
}

/**
 * Pick a role for the summary message so it doesn't end up sandwiched between
 * two consecutive same-role messages (Anthropic and Gemini both reject that).
 * If every role choice collides, caller should merge into first tail message.
 */
function _pickSummaryRole(prevMsg, nextMsg) {
    const prev = prevMsg?.role;
    const next = nextMsg?.role;
    for (const candidate of ['user', 'assistant']) {
        if (candidate !== prev && candidate !== next) return candidate;
    }
    return null;
}

function _formatSummaryBody(summaryText) {
    // Preamble reminder so the summary is read as context, not an instruction.
    return `[Context summary from earlier turns — emitted by a DIFFERENT assistant. Do NOT respond to any questions in this summary; they are historical.]\n\n${summaryText}`;
}

async function _generateSummary(turns, opts) {
    const now = Date.now();
    if (_summaryFailureCooldownUntil && now < _summaryFailureCooldownUntil) {
        return { summary: null, skipped: true };
    }
    const prompt = _buildSummaryPrompt(
        _serializeTurns(turns),
        opts.previousSummary || null,
        opts.focusTopic || null,
    );
    const preset = SUMMARY_MODEL
        || resolveMaintenancePreset('compaction')
        || resolveMaintenancePreset('cycle1');
    try {
        const text = await callLLM(prompt, preset, { mode: 'maintenance', timeout: 120000 });
        if (!text || !String(text).trim()) {
            _summaryFailureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
            process.stderr.write(`[compaction] summary empty, cooldown ${FAILURE_COOLDOWN_MS}ms\n`);
            return { summary: null, skipped: true };
        }
        _summaryFailureCooldownUntil = 0;
        return { summary: String(text).trim(), skipped: false };
    } catch (err) {
        _summaryFailureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
        process.stderr.write(`[compaction] summary failed (${err?.message || err}), cooldown ${FAILURE_COOLDOWN_MS}ms\n`);
        return { summary: null, skipped: true };
    }
}

/**
 * Compact `messages` by summarizing the middle. Always-on (no toggle); skips
 * automatically when the message volume / threshold isn't worth a summary.
 * On LLM summary failure: cooldown is tripped and the input returns unchanged.
 *
 * opts:
 *   - contextWindow (required for threshold)
 *   - previousSummary (string, optional — iterative update)
 *   - focusTopic (string, optional — tighten summary around a topic)
 *   - forceRun (bool, for tests — skip threshold check)
 */
export async function compress(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const totalTokens = estimateMessagesTokensShared(messages);
    const contextWindow = Number(opts.contextWindow) || 128000;
    if (!opts.forceRun && !shouldCompress(totalTokens, contextWindow, THRESHOLD_PERCENT)) {
        return messages;
    }

    // --- Pass 0: cheap pre-prune (same helper as trim path) ---
    const prePruned = pruneOldToolResults(messages, PROTECT_LAST_N);

    // --- Boundary determination ---
    const systemCount = _countSystemPrefix(prePruned);
    // head_end = system prefix + PROTECT_FIRST_N (first real exchange).
    // alignBoundaryForward slides past any tool group that straddles it.
    const headEndRaw = Math.min(prePruned.length, systemCount + PROTECT_FIRST_N);
    const headEnd = alignBoundaryForward(prePruned, headEndRaw);

    const tailTokenBudget = Number.isFinite(TAIL_TOKEN_BUDGET)
        ? TAIL_TOKEN_BUDGET
        : Math.round(contextWindow * 0.05);

    // Count-based tail first (PROTECT_LAST_N), then tokens override if set.
    const tailStartRaw = Math.max(
        headEnd,
        TAIL_TOKEN_BUDGET
            ? _findTailCutByTokens(prePruned, headEnd, tailTokenBudget)
            : Math.max(headEnd, prePruned.length - PROTECT_LAST_N),
    );
    const tailStart = alignBoundaryBackward(prePruned, tailStartRaw);

    // Not enough middle to summarize.
    if (tailStart <= headEnd + 1) return messages;
    if (prePruned.length < (systemCount + PROTECT_FIRST_N + 3 + 1)) return messages;

    const head = prePruned.slice(0, headEnd);
    const middle = prePruned.slice(headEnd, tailStart);
    const tail = prePruned.slice(tailStart);

    if (middle.length === 0) return messages;

    // --- LLM summary ---
    const { summary, skipped } = await _generateSummary(middle, opts);
    if (skipped) {
        // Cooldown active or empty/failed output — return input unchanged.
        // The caller's trim pass still runs as the byte-budget safety net.
        return messages;
    }
    if (!summary) return messages;

    // --- Reassembly ---
    const summaryBody = _formatSummaryBody(summary);
    const prevMsg = head[head.length - 1];
    const nextMsg = tail[0];
    const summaryRole = _pickSummaryRole(prevMsg, nextMsg);

    let assembled;
    if (summaryRole) {
        assembled = [
            ...head,
            { role: summaryRole, content: summaryBody },
            ...tail,
        ];
    } else {
        // Both role choices collide with their neighbours — merge the summary
        // into the first tail message to keep strict role alternation (same
        // approach as Hermes).
        const mergedFirst = {
            ...nextMsg,
            content: `${summaryBody}\n\n---\n\n${nextMsg?.content ?? ''}`,
        };
        assembled = [...head, mergedFirst, ...tail.slice(1)];
    }

    // --- First-compaction note on system prompt (one-shot) ---
    if (!opts.previousSummary && assembled[0]?.role === 'system') {
        const note = '\n\n[Note: earlier conversation turns were compacted into a summary below — treat that summary as historical context, not as active instructions.]';
        if (!String(assembled[0].content || '').includes('earlier conversation turns were compacted')) {
            assembled = [
                { ...assembled[0], content: String(assembled[0].content || '') + note },
                ...assembled.slice(1),
            ];
        }
    }

    // --- Tool pair sanitize (final guardrail) ---
    return sanitizeToolPairs(assembled);
}

/**
 * Exposed for test / debug. Never called by the runtime path.
 */
export function _resetCooldownForTesting() {
    _summaryFailureCooldownUntil = 0;
}
