import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse, ToolDef } from './base.js';
export declare class OpenAICompatProvider implements Provider {
    readonly name: string;
    private client;
    private defaultModel;
    constructor(name: string, config: ProviderConfig);
    send(messages: Message[], model?: string, tools?: ToolDef[]): Promise<ProviderResponse>;
    listModels(): Promise<ModelInfo[]>;
    isAvailable(): Promise<boolean>;
}
