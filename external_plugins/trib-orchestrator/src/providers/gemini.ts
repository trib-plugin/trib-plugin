import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse } from './base.js';

const MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1000000 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1000000 },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', contextWindow: 1000000 },
];

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  private genAI: GoogleGenerativeAI;

  constructor(config: ProviderConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey || process.env.GEMINI_API_KEY || '');
  }

  async send(messages: Message[], model?: string): Promise<ProviderResponse> {
    const useModel = model || 'gemini-2.5-flash';

    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    const genModel = this.genAI.getGenerativeModel({
      model: useModel,
      systemInstruction: systemMsgs.map(m => m.content).join('\n\n') || undefined,
    });

    // Build history (all except last user message)
    const history = chatMsgs.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: m.content }],
    }));

    const lastMsg = chatMsgs[chatMsgs.length - 1];
    if (!lastMsg) throw new Error('No messages to send');

    const chat = genModel.startChat({ history });
    const result = await chat.sendMessage(lastMsg.content);
    const response = result.response;

    return {
      content: response.text(),
      model: useModel,
      usage: response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount || 0,
        outputTokens: response.usageMetadata.candidatesTokenCount || 0,
      } : undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      await model.generateContent('hi');
      return true;
    } catch {
      return false;
    }
  }
}
