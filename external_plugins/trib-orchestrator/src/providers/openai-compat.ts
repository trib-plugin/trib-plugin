import OpenAI from 'openai';
import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse } from './base.js';

const PRESETS: Record<string, { baseURL: string; defaultModel: string; extraHeaders?: Record<string, string> }> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4',
    extraHeaders: { 'HTTP-Referer': 'trib-orchestrator', 'X-Title': 'trib-orchestrator' },
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-beta',
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.3:latest',
  },
  lmstudio: {
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'default',
  },
  local: {
    baseURL: 'http://localhost:8080/v1',
    defaultModel: 'default',
  },
};

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private client: OpenAI;
  private defaultModel: string;

  constructor(name: string, config: ProviderConfig) {
    const preset = PRESETS[name];
    const baseURL = config.baseURL || preset?.baseURL || 'http://localhost:8080/v1';
    const apiKey = config.apiKey || 'no-key';
    this.name = name;
    this.defaultModel = preset?.defaultModel || 'default';

    this.client = new OpenAI({
      baseURL,
      apiKey,
      defaultHeaders: preset?.extraHeaders,
    });
  }

  async send(messages: Message[], model?: string): Promise<ProviderResponse> {
    const useModel = model || this.defaultModel;
    const response = await this.client.chat.completions.create({
      model: useModel,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const choice = response.choices[0];
    return {
      content: choice?.message?.content || '',
      model: response.model,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens || 0,
        outputTokens: response.usage.completion_tokens || 0,
      } : undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const list = await this.client.models.list();
      const models: ModelInfo[] = [];
      for await (const m of list) {
        models.push({
          id: m.id,
          name: m.id,
          provider: this.name,
          contextWindow: 0,
        });
      }
      return models;
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
