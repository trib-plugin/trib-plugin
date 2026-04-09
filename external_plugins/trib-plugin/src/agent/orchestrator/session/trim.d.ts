import type { Message } from '../providers/base.js';
/**
 * Trim messages to fit within a token budget.
 * Strategy:
 *   1. Always keep system messages (first)
 *   2. Always keep the last user message
 *   3. First pass: truncate long tool_result outputs (>500 chars)
 *   4. Second pass: drop tool_result messages oldest-first
 *   5. Last resort: drop oldest non-system messages
 */
export declare function trimMessages(messages: Message[], budgetTokens: number): Message[];
