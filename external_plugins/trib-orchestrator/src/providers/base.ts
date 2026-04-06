export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderResponse {
  content: string;
  model: string;
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
  send(messages: Message[], model?: string): Promise<ProviderResponse>;
  listModels(): Promise<ModelInfo[]>;
  isAvailable(): Promise<boolean>;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  baseURL?: string;
}

export type ProvidersConfig = Record<string, ProviderConfig>;
