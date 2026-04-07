import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse, ToolDef } from './base.js';
export declare class AnthropicProvider implements Provider {
    readonly name = "anthropic";
    private client;
    constructor(config: ProviderConfig);
    send(messages: Message[], model?: string, tools?: ToolDef[]): Promise<ProviderResponse>;
    listModels(): Promise<ModelInfo[]>;
    isAvailable(): Promise<boolean>;
}
