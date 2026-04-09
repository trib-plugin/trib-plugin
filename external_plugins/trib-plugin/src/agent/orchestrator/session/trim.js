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
    // --- Pass 2: drop tool_result messages oldest-first ---
    let total = estimateMessagesTokens(middle);
    while (total + baseCost > budgetTokens) {
        const toolIdx = middle.findIndex(m => m.role === 'tool');
        if (toolIdx === -1)
            break;
        total -= estimateTokens(middle[toolIdx].content) + 4;
        middle.splice(toolIdx, 1);
    }
    if (total + baseCost <= budgetTokens) {
        return [...system, ...middle, lastMsg];
    }
    // --- Pass 3: drop oldest non-system messages ---
    let remaining = budgetTokens - baseCost;
    const kept = [];
    for (let i = middle.length - 1; i >= 0; i--) {
        const cost = estimateTokens(middle[i].content) + 4;
        if (remaining - cost < 0)
            break;
        remaining -= cost;
        kept.unshift(middle[i]);
    }
    return [...system, ...kept, lastMsg];
}
