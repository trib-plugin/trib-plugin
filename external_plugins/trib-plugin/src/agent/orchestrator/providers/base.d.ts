export interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
}
export interface ProviderResponse {
    content: string;
    model: string;
    toolCalls?: ToolCall[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
}
export interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
}
export interface Provider {
    readonly name: string;
    send(messages: Message[], model?: string, tools?: ToolDef[]): Promise<ProviderResponse>;
    listModels(): Promise<ModelInfo[]>;
    isAvailable(): Promise<boolean>;
}
export interface ProviderConfig {
    enabled: boolean;
    apiKey?: string;
    baseURL?: string;
}
export type ProvidersConfig = Record<string, ProviderConfig>;
