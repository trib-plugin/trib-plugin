import Anthropic from '@anthropic-ai/sdk';
import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse } from './base.js';

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-0', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200000 },
  { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000 },
];

const MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-0': 32768,
  'claude-sonnet-4-0': 16384,
  'claude-haiku-4-5-20251001': 8192,
};

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async send(messages: Message[], model?: string): Promise<ProviderResponse> {
    const useModel = model || 'claude-sonnet-4-0';
    const maxTokens = MAX_TOKENS[useModel] || 8192;

    // Anthropic separates system from messages
    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    const response = await this.client.messages.create({
      model: useModel,
      max_tokens: maxTokens,
      system: systemMsgs.map(m => m.content).join('\n\n') || undefined,
      messages: chatMsgs.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return {
      content: textBlock?.type === 'text' ? textBlock.text : '',
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return true;
    } catch {
      return false;
    }
  }
}
