import type { Message } from '../providers/base.js';

// Rough token estimate: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * Trim messages to fit within a token budget.
 * Strategy:
 *   1. Always keep system messages (first)
 *   2. Always keep the last user message
 *   3. Remove oldest non-system messages until within budget
 */
export function trimMessages(messages: Message[], budgetTokens: number): Message[] {
  const total = estimateMessagesTokens(messages);
  if (total <= budgetTokens) return messages;

  // Separate system messages from the rest
  const system = messages.filter(m => m.role === 'system');
  const rest = messages.filter(m => m.role !== 'system');

  if (rest.length === 0) return system;

  // Always keep the last message (the new user prompt)
  const lastMsg = rest[rest.length - 1]!;
  const middle = rest.slice(0, -1);

  // Calculate base cost (system + last message)
  const baseCost = estimateMessagesTokens(system) + estimateMessagesTokens([lastMsg]);
  let remaining = budgetTokens - baseCost;

  if (remaining <= 0) {
    // Can't even fit system + last message — just send those
    return [...system, lastMsg];
  }

  // Keep as many recent messages as possible
  const kept: Message[] = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const cost = estimateTokens(middle[i]!.content) + 4;
    if (remaining - cost < 0) break;
    remaining -= cost;
    kept.unshift(middle[i]!);
  }

  return [...system, ...kept, lastMsg];
}
