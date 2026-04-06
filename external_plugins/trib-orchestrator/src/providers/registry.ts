import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse, ProvidersConfig } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { getCopilotBearerToken } from './copilot-auth.js';

const OPENAI_COMPAT_PROVIDERS = ['openai', 'groq', 'openrouter', 'xai', 'ollama', 'lmstudio', 'local'];

/**
 * Copilot wrapper — recreates the inner OpenAI client when the bearer token expires.
 */
class CopilotProvider implements Provider {
  readonly name = 'copilot';
  private inner: OpenAICompatProvider | null = null;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private async ensureClient(): Promise<OpenAICompatProvider> {
    const token = await getCopilotBearerToken();
    if (!token) throw new Error('Failed to obtain Copilot bearer token');
    // getCopilotBearerToken returns cached token if still valid,
    // or refreshes if expired — so recreating is cheap when cached
    this.inner = new OpenAICompatProvider('copilot', {
      ...this.config,
      apiKey: token,
      baseURL: this.config.baseURL || 'https://api.githubcopilot.com',
    });
    return this.inner;
  }

  async send(messages: Message[], model?: string): Promise<ProviderResponse> {
    const client = await this.ensureClient();
    return client.send(messages, model);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const client = await this.ensureClient();
      return client.listModels();
    } catch { return []; }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureClient();
      return true;
    } catch { return false; }
  }
}

const providers = new Map<string, Provider>();

export async function initProviders(config: ProvidersConfig): Promise<void> {
  providers.clear();

  for (const [name, cfg] of Object.entries(config)) {
    if (!cfg.enabled) continue;

    if (name === 'anthropic') {
      providers.set(name, new AnthropicProvider(cfg));
    } else if (name === 'gemini') {
      providers.set(name, new GeminiProvider(cfg));
    } else if (name === 'copilot') {
      providers.set(name, new CopilotProvider(cfg));
    } else if (OPENAI_COMPAT_PROVIDERS.includes(name)) {
      providers.set(name, new OpenAICompatProvider(name, cfg));
    } else {
      providers.set(name, new OpenAICompatProvider(name, cfg));
    }
  }
}

export function getProvider(name: string): Provider | undefined {
  return providers.get(name);
}

export function getAllProviders(): Map<string, Provider> {
  return providers;
}

export function listProviderNames(): string[] {
  return [...providers.keys()];
}
