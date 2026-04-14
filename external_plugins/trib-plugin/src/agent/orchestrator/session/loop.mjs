import { executeMcpTool, isMcpTool } from '../mcp/client.mjs';
import { executeBuiltinTool, isBuiltinTool } from '../tools/builtin.mjs';
import { loadSkillContent } from '../context/collect.mjs';
import { traceBridgeLoop, traceBridgeTool, estimateProviderPayloadBytes } from '../bridge-trace.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError } from './manager.mjs';
const MAX_ITERATIONS = 100;
/**
 * Execute a single tool call — routes to MCP or builtin.
 */
function getToolKind(name) {
    if (name === 'skill') return 'skill';
    if (isMcpTool(name)) return 'mcp';
    if (isBuiltinTool(name)) return 'builtin';
    return 'builtin';
}
async function executeTool(name, args, cwd) {
    if (name === 'skill') {
        const skillName = args.name;
        if (!skillName)
            return 'Error: skill name is required';
        const content = loadSkillContent(skillName, cwd);
        return content || `Error: skill "${skillName}" not found`;
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
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const reason = signal.reason instanceof Error ? signal.reason : null;
            if (reason instanceof SessionClosedError) throw reason;
            throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
        }
    };
    while (true) {
        throwIfAborted();
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        const sendStartedAt = Date.now();
        response = await provider.send(messages, model, tools.length ? tools : undefined, opts);
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
    };
}
