import type { Message, ProviderResponse } from '../providers/base.js';
import { getProvider } from '../providers/registry.js';
import { trimMessages } from './trim.js';

export interface Session {
  id: string;
  provider: string;
  model: string;
  messages: Message[];
  contextWindow: number;
  createdAt: number;
  updatedAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const sessions = new Map<string, Session>();
let nextId = 1;

// Rough context windows for common models
const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'o4-mini': 200000,
  'claude-opus-4-0': 200000,
  'claude-sonnet-4-0': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.0-flash': 1000000,
  'llama-3.3-70b-versatile': 128000,
  'llama3.3:latest': 8192,
  'grok-3-beta': 131072,
};

function guessContextWindow(model: string): number {
  if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];
  // Local models default small
  if (model.includes('llama') || model.includes('mistral') || model.includes('phi')) return 8192;
  return 128000;
}

export function createSession(opts: {
  provider: string;
  model: string;
  systemPrompt?: string;
  files?: Array<{ path: string; content: string }>;
}): Session {
  const provider = getProvider(opts.provider);
  if (!provider) throw new Error(`Provider "${opts.provider}" not found or not enabled`);

  const id = `sess_${nextId++}_${Date.now()}`;
  const messages: Message[] = [];

  // System prompt
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }

  // Inject files as context
  if (opts.files?.length) {
    const fileContext = opts.files
      .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');
    messages.push({
      role: 'user',
      content: `Reference files:\n\n${fileContext}`,
    });
    messages.push({
      role: 'assistant',
      content: 'Understood. I have the files in context.',
    });
  }

  const session: Session = {
    id,
    provider: opts.provider,
    model: opts.model,
    messages,
    contextWindow: guessContextWindow(opts.model),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  sessions.set(id, session);
  return session;
}

export interface AskResult extends ProviderResponse {
  trimmed: boolean;
  messagesDropped: number;
}

export async function askSession(sessionId: string, prompt: string): Promise<AskResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const provider = getProvider(session.provider);
  if (!provider) throw new Error(`Provider "${session.provider}" not available`);

  // Build messages with the new prompt (don't mutate session yet)
  const beforeCount = session.messages.length + 1; // +1 for the new user message
  const budget = Math.floor(session.contextWindow * 0.8);
  const outgoing = trimMessages(
    [...session.messages, { role: 'user' as const, content: prompt }],
    budget,
  );
  const messagesDropped = beforeCount - outgoing.length;

  // Call provider — if this throws, session state is untouched
  const response = await provider.send(outgoing, session.model);

  // Success — commit both user message and assistant response
  session.messages = outgoing;
  session.messages.push({ role: 'assistant', content: response.content });
  session.updatedAt = Date.now();

  if (response.usage) {
    session.totalInputTokens += response.usage.inputTokens;
    session.totalOutputTokens += response.usage.outputTokens;
  }

  return {
    ...response,
    trimmed: messagesDropped > 0,
    messagesDropped,
  };
}

export function injectContext(sessionId: string, opts: {
  files?: Array<{ path: string; content: string }>;
  content?: string;
}): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const parts: string[] = [];

  if (opts.files?.length) {
    for (const f of opts.files) {
      parts.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
  }
  if (opts.content) {
    parts.push(opts.content);
  }

  if (parts.length) {
    session.messages.push({ role: 'user', content: `Additional context:\n\n${parts.join('\n\n')}` });
    session.messages.push({ role: 'assistant', content: 'Noted.' });
    session.updatedAt = Date.now();
  }
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return [...sessions.values()];
}

export function closeSession(id: string): boolean {
  return sessions.delete(id);
}
