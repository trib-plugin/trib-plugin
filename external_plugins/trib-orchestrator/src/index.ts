import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders, getAllProviders } from './providers/registry.js';
import {
  createSession,
  askSession,
  injectContext,
  listSessions,
  closeSession,
  getSession,
} from './session/manager.js';
import { loadConfig } from './config.js';

const mcp = new Server(
  { name: 'trib-orchestrator', version: '0.1.0' },
  { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } },
);

// --- Types ---

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// --- Channel notification ---

function notify(text: string) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: { user: 'trib-orchestrator', user_id: 'system', ts: new Date().toISOString() },
    },
  }).catch(() => {});
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'create_session',
    title: 'Create Session',
    annotations: { title: 'Create Session', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Create a new AI session with a specific provider and model. Returns a session ID for stateful conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        provider: { type: 'string', description: 'Provider name (openai, anthropic, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local)' },
        model: { type: 'string', description: 'Model ID (e.g., gpt-4o, claude-sonnet-4-0, gemini-2.5-pro, llama3.3:latest)' },
        systemPrompt: { type: 'string', description: 'System prompt / instructions for this session' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Files to inject as context' },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'ask',
    title: 'Ask',
    annotations: { title: 'Ask', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Send a message to a session. Returns immediately, result is pushed via channel notification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID from create_session' },
        prompt: { type: 'string', description: 'The message to send' },
      },
      required: ['sessionId', 'prompt'],
    },
  },
  {
    name: 'inject',
    title: 'Inject Context',
    annotations: { title: 'Inject Context', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Inject additional context (files, text) into an existing session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Files to inject' },
        content: { type: 'string', description: 'Raw text content to inject' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_sessions',
    title: 'List Sessions',
    annotations: { title: 'List Sessions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'List all active sessions.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'close_session',
    title: 'Close Session',
    annotations: { title: 'Close Session', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Close and discard a session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Session ID to close' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_models',
    title: 'List Models',
    annotations: { title: 'List Models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'List available models from all enabled providers. For local providers (ollama, lmstudio), shows installed models.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'team_review',
    title: 'Team Review',
    annotations: { title: 'Team Review', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Fan-out a prompt to multiple providers simultaneously. Results are pushed via channel notifications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targets: { type: 'array', items: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } }, required: ['provider', 'model'] }, description: 'Array of { provider, model } to query' },
        prompt: { type: 'string', description: 'The prompt to send to all targets' },
        systemPrompt: { type: 'string', description: 'Shared system prompt' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Shared files for context' },
      },
      required: ['targets', 'prompt'],
    },
  },
];

// --- Handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'create_session': {
        const session = createSession(args as Parameters<typeof createSession>[0]);
        return ok({ sessionId: session.id, provider: session.provider, model: session.model, contextWindow: session.contextWindow });
      }

      case 'ask': {
        const session = getSession(args.sessionId as string);
        if (!session) return fail(`Session "${args.sessionId}" not found`);

        const startedAt = Date.now();
        askSession(args.sessionId as string, args.prompt as string).then(response => {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          notify(`### ${response.model || session.model} (${elapsed}s)\n${response.content}`);
        }).catch(err => {
          notify(`${session.model} error: ${err instanceof Error ? err.message : String(err)}`);
        });

        return ok(`${session.model}에 요청 전송됨`);
      }

      case 'inject': {
        injectContext(args.sessionId as string, args as Parameters<typeof injectContext>[1]);
        const session = getSession(args.sessionId as string);
        return ok(`Context injected into session ${args.sessionId}. Messages: ${session?.messages.length || 0}`);
      }

      case 'list_sessions': {
        return ok(listSessions().map(s => ({
          id: s.id, provider: s.provider, model: s.model, messages: s.messages.length,
          inputTokens: s.totalInputTokens, outputTokens: s.totalOutputTokens,
          createdAt: new Date(s.createdAt).toISOString(),
        })));
      }

      case 'close_session': {
        const closed = closeSession(args.sessionId as string);
        return ok(closed ? `Session ${args.sessionId} closed.` : `Session ${args.sessionId} not found.`);
      }

      case 'list_models': {
        const allProviders = getAllProviders();
        const settled = await Promise.allSettled(
          Array.from(allProviders).map(async ([provName, provider]) => {
            const models = await provider.listModels();
            return { provider: provName, models: models.map(m => ({ id: m.id, name: m.name })) };
          }),
        );
        const results = settled.map((outcome, idx) => {
          if (outcome.status === 'fulfilled') return outcome.value;
          const provName = Array.from(allProviders)[idx][0];
          return { provider: provName, models: [] as Array<{ id: string; name: string }> };
        });
        return ok(results);
      }

      case 'team_review': {
        const targets = args.targets as Array<{ provider: string; model: string }>;
        const startedAt = Date.now();

        Promise.allSettled(
          targets.map(async (target) => {
            const session = createSession({ provider: target.provider, model: target.model, systemPrompt: args.systemPrompt as string | undefined, files: args.files as Array<{ path: string; content: string }> | undefined });
            try {
              const response = await askSession(session.id, args.prompt as string);
              const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
              notify(`### ${response.model || target.model} (${elapsed}s)\n${response.content}`);
            } catch (err) {
              notify(`### ${target.model}\nError: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              closeSession(session.id);
            }
          }),
        ).catch(() => {});

        return ok(`${targets.length}개 모델에 요청 전송됨`);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});

// --- Start ---

async function main() {
  const config = loadConfig();
  await initProviders(config.providers);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Failed to start trib-orchestrator: ${err}\n`);
  process.exit(1);
});
