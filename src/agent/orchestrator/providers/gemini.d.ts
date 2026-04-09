import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse, ToolDef } from './base.js';
export declare class GeminiProvider implements Provider {
    readonly name = "gemini";
    private genAI;
    constructor(config: ProviderConfig);
    send(messages: Message[], model?: string, tools?: ToolDef[]): Promise<ProviderResponse>;
    listModels(): Promise<ModelInfo[]>;
    isAvailable(): Promise<boolean>;
}
