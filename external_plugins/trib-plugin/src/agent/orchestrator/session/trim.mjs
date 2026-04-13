// Rough token estimate: ~4 chars per token
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
const TOOL_TRUNCATE_THRESHOLD = 500;
/**
 * Truncate long tool_result messages to save tokens.
 * Returns a shallow copy with truncated content where applicable.
 */
function truncateToolResults(messages) {
    return messages.map(m => {
        if (m.role === 'tool' && m.content.length > TOOL_TRUNCATE_THRESHOLD) {
            return { ...m, content: m.content.slice(0, TOOL_TRUNCATE_THRESHOLD) + '\n[truncated]' };
        }
        return m;
    });
}
/**
 * Trim messages to fit within a token budget.
 * Strategy:
 *   1. Always keep system messages (first)
 *   2. Always keep the last user message
 *   3. First pass: truncate long tool_result outputs (>500 chars)
 *   4. Second pass: drop tool_result messages oldest-first
 *   5. Last resort: drop oldest non-system messages
 */
export function trimMessages(messages, budgetTokens) {
    if (estimateMessagesTokens(messages) <= budgetTokens)
        return messages;
    // --- Pass 1: truncate long tool results ---
    let trimmed = truncateToolResults(messages);
    if (estimateMessagesTokens(trimmed) <= budgetTokens)
        return trimmed;
    // Separate system messages from the rest
    const system = trimmed.filter(m => m.role === 'system');
    const rest = trimmed.filter(m => m.role !== 'system');
    if (rest.length === 0)
        return system;
    const lastMsg = rest[rest.length - 1];
    let middle = rest.slice(0, -1);
    const baseCost = estimateMessagesTokens(system) + estimateMessagesTokens([lastMsg]);
    if (baseCost >= budgetTokens) {
        return [...system, lastMsg];
    }
    // --- Pass 2: drop tool-result messages oldest-first (with paired assistant) ---
    let total = estimateMessagesTokens(middle);
    while (total + baseCost > budgetTokens) {
        const toolIdx = middle.findIndex(m => m.role === 'tool');
        if (toolIdx === -1)
            break;
        const toolCallId = middle[toolIdx].toolCallId;
        total -= estimateTokens(middle[toolIdx].content) + 4;
        middle.splice(toolIdx, 1);
        // Also drop the paired assistant message that issued this tool call
        if (toolCallId) {
            const assistantIdx = middle.findIndex(m =>
                m.role === 'assistant' && Array.isArray(m.toolCalls) &&
                m.toolCalls.some(tc => tc.id === toolCallId)
            );
            if (assistantIdx !== -1) {
                // Only drop the assistant msg if ALL its tool calls have been dropped
                const assistantMsg = middle[assistantIdx];
                const remainingCalls = assistantMsg.toolCalls.filter(tc =>
                    middle.some(m => m.role === 'tool' && m.toolCallId === tc.id)
                );
                if (remainingCalls.length === 0) {
                    total -= estimateTokens(assistantMsg.content || '') + 4;
                    middle.splice(assistantIdx, 1);
                }
            }
        }
    }
    if (total + baseCost <= budgetTokens) {
        return [...system, ...middle, lastMsg];
    }
    // --- Pass 3: drop oldest non-system messages (preserving tool-call pairs) ---
    let remaining = budgetTokens - baseCost;
    const kept = [];
    for (let i = middle.length - 1; i >= 0; i--) {
        const m = middle[i];
        const cost = estimateTokens(m.content || '') + 4;
        if (remaining - cost < 0)
            break;
        // If this is a tool result, ensure its paired assistant is also in kept
        if (m.role === 'tool' && m.toolCallId) {
            const pairedIdx = middle.findIndex((a, idx) =>
                idx < i && a.role === 'assistant' && Array.isArray(a.toolCalls) &&
                a.toolCalls.some(tc => tc.id === m.toolCallId)
            );
            if (pairedIdx !== -1 && !kept.includes(middle[pairedIdx])) {
                const pairedCost = estimateTokens(middle[pairedIdx].content || '') + 4;
                if (remaining - cost - pairedCost < 0)
                    break;
                remaining -= pairedCost;
                kept.unshift(middle[pairedIdx]);
            }
        }
        // If this is an assistant with toolCalls, ensure all tool results are also in kept
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            const toolResultCosts = m.toolCalls.reduce((sum, tc) => {
                const toolMsg = middle.find(t =>
                    t.role === 'tool' && t.toolCallId === tc.id &&
                    !kept.includes(t)
                );
                return sum + (toolMsg ? estimateTokens(toolMsg.content || '') + 4 : 0);
            }, 0);
            if (remaining - cost - toolResultCosts < 0)
                break;
            // Add the tool results that haven't been added yet
            for (const tc of m.toolCalls) {
                const toolMsg = middle.find(t =>
                    t.role === 'tool' && t.toolCallId === tc.id &&
                    !kept.includes(t)
                );
                if (toolMsg) {
                    remaining -= estimateTokens(toolMsg.content || '') + 4;
                    kept.push(toolMsg);
                }
            }
        }
        remaining -= cost;
        kept.unshift(m);
    }
    // Sort kept by original order to preserve conversation flow
    const middleOrder = new Map(middle.map((m, idx) => [m, idx]));
    kept.sort((a, b) => (middleOrder.get(a) ?? 0) - (middleOrder.get(b) ?? 0));
    return [...system, ...kept, lastMsg];
}
