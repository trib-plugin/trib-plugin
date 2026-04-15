import { executeMcpTool, isMcpTool } from '../mcp/client.mjs';
import { executeBuiltinTool, isBuiltinTool } from '../tools/builtin.mjs';
import { collectSkillsCached, loadSkillContent } from '../context/collect.mjs';
import { traceBridgeLoop, traceBridgeTool, estimateProviderPayloadBytes } from '../bridge-trace.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError } from './manager.mjs';
import { trimMessages } from './trim.mjs';
import {
    shouldCompress,
    compress,
    estimateMessagesTokensRough,
    THRESHOLD_PERCENT,
} from './compressor.mjs';
const SAFETY_TRIM_PERCENT = 0.90;
const MAX_ITERATIONS = 100;
const SKILL_TOOL_NAMES = new Set(['skills_list', 'skill_view', 'skill_execute']);
/**
 * Execute a single tool call — routes to MCP or builtin.
 */
function getToolKind(name) {
    if (SKILL_TOOL_NAMES.has(name)) return 'skill';
    if (isMcpTool(name)) return 'mcp';
    if (isBuiltinTool(name)) return 'builtin';
    return 'builtin';
}
function buildSkillsListResponse(cwd) {
    const skills = collectSkillsCached(cwd);
    const entries = skills.map(s => ({ name: s.name, description: s.description || '' }));
    return JSON.stringify({ skills: entries });
}
function viewSkill(cwd, name) {
    if (!name) return 'Error: skill name is required';
    const content = loadSkillContent(name, cwd);
    return content || `Error: skill "${name}" not found`;
}
function executeSkill(cwd, name, _args) {
    if (!name) return 'Error: skill name is required';
    const content = loadSkillContent(name, cwd);
    return content || `Error: skill "${name}" not found`;
}
async function executeTool(name, args, cwd) {
    if (name === 'skills_list') {
        return buildSkillsListResponse(cwd);
    }
    if (name === 'skill_view') {
        return viewSkill(cwd, args?.name);
    }
    if (name === 'skill_execute') {
        return executeSkill(cwd, args?.name, args?.args);
    }
    if (isMcpTool(name)) {
        return executeMcpTool(name, args);
    }
    if (isBuiltinTool(name)) {
        return executeBuiltinTool(name, args, cwd);
    }
    return `Error: unknown tool "${name}"`;
}
/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 * sendOpts may include:
 *   - `effort` (provider-specific)
 *   - `fast` (boolean)
 *   - `sessionId` — enables runtime liveness markers (optional)
 *   - `signal` — AbortSignal; checked at each iteration boundary and after each
 *                tool. When aborted, throws SessionClosedError so the ask
 *                wrapper can propagate a clean cancellation.
 *   - `onStageChange(stage)` / `onStreamDelta()` — forwarded to provider.send for heartbeats
 */
export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let response;
    const opts = sendOpts || {};
    const sessionId = opts.sessionId || null;
    const signal = opts.signal || null;
    // Opaque providerState passthrough. The loop never inspects it; only the
    // originating provider does. Seed from sendOpts.providerState if the
    // manager restored one. No provider currently emits state (Codex OAuth is
    // stateless per contract); field remains undefined end-to-end for now.
    let providerState = opts.providerState ?? undefined;
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const reason = signal.reason instanceof Error ? signal.reason : null;
            if (reason instanceof SessionClosedError) throw reason;
            throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
        }
    };
    // Session ref for in-flight compressor state. Provided by the caller when
    // available (askSession passes it); the loop mutates messages in place.
    const sessionRef = opts.session || null;
    while (true) {
        throwIfAborted();
        // --- Hermes-style in-flight compression (before each provider.send) ---
        // Only runs when we have a session ref (i.e. called from askSession).
        // Threshold: messages token estimate >= contextWindow * THRESHOLD_PERCENT.
        // Failure cooldown is handled inside compressor.mjs via its per-process
        // _summaryFailureCooldownUntil gate — no session-level gate here.
        if (sessionRef && typeof sessionRef.contextWindow === 'number') {
            try {
                const currentTokens = estimateMessagesTokensRough(messages);
                const thresholdTokens = Math.round(sessionRef.contextWindow * THRESHOLD_PERCENT);
                if (shouldCompress(messages, currentTokens, thresholdTokens)) {
                    const result = await compress(messages, {
                        provider,
                        sendOpts: { ...opts, model },
                        previousSummary: sessionRef.previousSummary || null,
                        focusTopic: null,
                        contextLength: sessionRef.contextWindow,
                        thresholdTokens,
                    });
                    if (result.compressed && Array.isArray(result.messages)) {
                        // Mutate the shared array in place so callers holding the
                        // same reference observe the compaction.
                        messages.length = 0;
                        messages.push(...result.messages);
                        sessionRef.previousSummary = result.summary || sessionRef.previousSummary || null;
                        sessionRef.compressionCount = (sessionRef.compressionCount || 0) + 1;
                    }
                }
            } catch (err) {
                process.stderr.write(`[loop] compressor error: ${err?.message || err}\n`);
            }
            // Safety net: hard-limit byte trim after compaction (or when
            // compaction declined). Compaction is primary; this only drops
            // messages when the total still exceeds SAFETY_TRIM_PERCENT of the
            // context window — prevents sending bodies past provider limits.
            const safetyBudget = Math.floor(sessionRef.contextWindow * SAFETY_TRIM_PERCENT);
            const trimmed = trimMessages(messages, safetyBudget);
            if (trimmed.length !== messages.length) {
                messages.length = 0;
                messages.push(...trimmed);
            }
        }
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        const sendStartedAt = Date.now();
        response = await provider.send(messages, model, tools.length ? tools : undefined, opts);
        // Capture opaque state for the next turn (may be undefined — that's
        // the stateless contract for providers that don't use continuation).
        providerState = response?.providerState ?? undefined;
        iterations = nextIteration;
        traceBridgeLoop({
            sessionId,
            iteration: iterations,
            sendMs: Date.now() - sendStartedAt,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            bodyBytesEst: estimateProviderPayloadBytes(messages, model, tools),
        });
        // Accumulate usage across iterations
        if (response.usage) {
            if (lastUsage) {
                lastUsage.inputTokens += response.usage.inputTokens;
                lastUsage.outputTokens += response.usage.outputTokens;
            }
            else {
                lastUsage = { ...response.usage };
            }
        }
        // Provider may have returned despite an abort (SDKs that don't honour
        // signal) — bail before processing any of its output.
        throwIfAborted();
        // No tool calls — done
        if (!response.toolCalls?.length)
            break;
        // Safety limit
        if (iterations > MAX_ITERATIONS) {
            response.content = (response.content || '') +
                `\n\n[Agent loop stopped: reached ${MAX_ITERATIONS} iterations]`;
            break;
        }
        const calls = response.toolCalls;
        toolCallsTotal += calls.length;
        onToolCall?.(iterations, calls);
        // Append assistant message with tool calls
        messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: calls,
        });
        // Execute each tool and append results
        for (const call of calls) {
            if (sessionId) markSessionToolCall(sessionId, call.name);
            let result;
            const toolStartedAt = Date.now();
            const toolKind = getToolKind(call.name);
            try {
                result = await executeTool(call.name, call.arguments, cwd);
            }
            catch (err) {
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            traceBridgeTool({
                sessionId,
                iteration: iterations,
                toolName: call.name,
                toolKind,
                toolMs: Date.now() - toolStartedAt,
            });
            messages.push({
                role: 'tool',
                content: result,
                toolCallId: call.id,
            });
            // Soft-cancel after each tool: if close landed during execution,
            // discard the rest of the batch and skip the next provider.send.
            throwIfAborted();
        }
        // About to re-send with tool results — transition back to connecting for the next turn.
        if (sessionId) updateSessionStage(sessionId, 'connecting');
    }
    return {
        ...response,
        usage: lastUsage || response.usage,
        iterations,
        toolCallsTotal,
        providerState,
    };
}
