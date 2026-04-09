import type { Message, ProviderResponse, ToolCall, ToolDef } from '../providers/base.js';
import type { Provider } from '../providers/base.js';
export interface LoopResult extends ProviderResponse {
    iterations: number;
    toolCallsTotal: number;
}
/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 */
export declare function agentLoop(provider: Provider, messages: Message[], model: string, tools: ToolDef[], onToolCall?: (iteration: number, calls: ToolCall[]) => void, cwd?: string): Promise<LoopResult>;
