import { executeMcpTool, isMcpTool } from '../mcp/client.mjs';
import { executeBuiltinTool, isBuiltinTool } from '../tools/builtin.mjs';
import { loadSkillContent } from '../context/collect.mjs';
const MAX_ITERATIONS = 100;
/**
 * Execute a single tool call — routes to MCP or builtin.
 */
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
 * sendOpts may include `effort` (provider-specific value) and `fast` (boolean).
 */
export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let response;
    const opts = sendOpts || {};
    while (true) {
        response = await provider.send(messages, model, tools.length ? tools : undefined, opts);
        iterations++;
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
            let result;
            try {
                result = await executeTool(call.name, call.arguments, cwd);
            }
            catch (err) {
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            messages.push({
                role: 'tool',
                content: result,
                toolCallId: call.id,
            });
        }
    }
    return {
        ...response,
        usage: lastUsage || response.usage,
        iterations,
        toolCallsTotal,
    };
}
