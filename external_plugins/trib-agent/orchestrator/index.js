import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders, getAllProviders } from './providers/registry.js';
import { createSession, resumeSession, listSessions, closeSession, } from './session/manager.js';
import { loadConfig } from './config.js';
import { connectMcpServers, disconnectAll } from './mcp/client.js';
const mcp = new Server({ name: 'trib-agent', version: '0.3.0' }, { capabilities: { tools: {} } });
function ok(data) {
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function fail(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}
// --- Tool definitions (ask removed — use CLI via Bash) ---
const TOOLS = [
    {
        name: 'create_session',
        description: 'Create an external AI session. Auto-injects CLAUDE.md, agent rules, skills. Registers builtin+MCP tools. Use preset: "full"/"readonly"/"mcp". Use agent: "Worker"/"Reviewer". Pass cwd for project-scoped tool execution.',
        inputSchema: {
            type: 'object',
            properties: {
                provider: { type: 'string', description: 'openai, openai-oauth, anthropic, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local' },
                model: { type: 'string', description: 'e.g., gpt-5.4-mini, claude-sonnet-4-0, gemini-2.5-pro' },
                systemPrompt: { type: 'string', description: 'Additional system prompt' },
                agent: { type: 'string', description: 'Agent template: "Worker", "Reviewer"' },
                preset: { type: 'string', enum: ['full', 'readonly', 'mcp'], description: 'Tool preset (default: full)' },
                files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
                cwd: { type: 'string', description: 'Working directory for builtin tool execution and CLAUDE.md/agents/skills lookup. Defaults to MCP server cwd.' },
            },
            required: ['provider', 'model'],
        },
    },
    {
        name: 'resume_session',
        description: 'Resume an existing session (e.g., after server restart). Refreshes tool registrations.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'Session ID to resume' },
                preset: { type: 'string', enum: ['full', 'readonly', 'mcp'], description: 'Optionally change tool preset' },
            },
            required: ['sessionId'],
        },
    },
    {
        name: 'list_sessions',
        description: 'List all sessions (active and stored).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'close_session',
        description: 'Close and delete a session.',
        inputSchema: {
            type: 'object',
            properties: { sessionId: { type: 'string' } },
            required: ['sessionId'],
        },
    },
    {
        name: 'list_models',
        description: 'List available models from all enabled providers.',
        inputSchema: { type: 'object', properties: {} },
    },
];
// --- Handlers ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {});
    try {
        switch (name) {
            case 'create_session': {
                const session = createSession(args);
                return ok({
                    sessionId: session.id,
                    provider: session.provider,
                    model: session.model,
                    contextWindow: session.contextWindow,
                    toolsAvailable: session.tools.length,
                    toolNames: session.tools.map(t => t.name),
                    hint: `Use Bash to ask: node "\${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" ask ${session.id} "your prompt"`,
                });
            }
            case 'resume_session': {
                const session = resumeSession(args.sessionId, args.preset);
                if (!session)
                    return fail(`Session "${args.sessionId}" not found`);
                return ok({
                    sessionId: session.id,
                    provider: session.provider,
                    model: session.model,
                    messages: session.messages.length,
                    toolsAvailable: session.tools.length,
                });
            }
            case 'list_sessions': {
                return ok(listSessions().map(s => ({
                    id: s.id, provider: s.provider, model: s.model,
                    messages: s.messages.length, tools: s.tools.length,
                    inputTokens: s.totalInputTokens, outputTokens: s.totalOutputTokens,
                    createdAt: new Date(s.createdAt).toISOString(),
                    updatedAt: new Date(s.updatedAt).toISOString(),
                })));
            }
            case 'close_session': {
                const closed = closeSession(args.sessionId);
                return ok(closed ? `Session ${args.sessionId} closed.` : `Session ${args.sessionId} not found.`);
            }
            case 'list_models': {
                const results = [];
                for (const [provName, provider] of getAllProviders()) {
                    try {
                        const models = await provider.listModels();
                        results.push({ provider: provName, models: models.map(m => ({ id: m.id, name: m.name })) });
                    }
                    catch {
                        results.push({ provider: provName, models: [] });
                    }
                }
                return ok(results);
            }
            default:
                return fail(`Unknown tool: ${name}`);
        }
    }
    catch (err) {
        return fail(err);
    }
});
// --- Start ---
async function main() {
    // loadConfig handles legacy mcp-tools.json migration into config.json automatically
    const config = loadConfig();
    await initProviders(config.providers);
    // MCP tool servers come from config.mcpServers (config.json)
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        process.stderr.write(`[orchestrator] Loading ${Object.keys(config.mcpServers).length} MCP tool server(s) from config.json\n`);
        await connectMcpServers(config.mcpServers);
    }
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    process.on('SIGINT', async () => { await disconnectAll(); process.exit(0); });
}
main().catch((err) => {
    process.stderr.write(`Failed to start trib-agent: ${err}\n`);
    process.exit(1);
});
