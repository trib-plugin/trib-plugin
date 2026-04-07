import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// --- Types ---
/** Known auto-detect targets: port file path relative to tmpdir */
const AUTO_DETECT_PORTS = {
    'trib-memory': { dir: 'trib-memory', file: 'memory-port', endpoint: '/mcp' },
    'trib-channels': { dir: 'trib-channels', file: 'active-instance.json', endpoint: '/mcp', portField: 'httpPort' },
};
// --- State ---
const servers = new Map();
// --- Public API ---
/**
 * Connect to MCP servers defined in config.
 * Supports stdio (child process) and http (Streamable HTTP) transports.
 */
export async function connectMcpServers(config) {
    for (const [name, cfg] of Object.entries(config)) {
        try {
            await connectServer(name, cfg);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[mcp-client] Failed to connect "${name}": ${msg}\n`);
        }
    }
}
/**
 * Get all tool definitions from connected MCP servers.
 * Tool names are prefixed: `mcp__{serverName}__{toolName}`
 */
export function getMcpTools() {
    const tools = [];
    for (const server of servers.values()) {
        tools.push(...server.tools);
    }
    return tools;
}
/**
 * Execute an MCP tool call.
 * Name format: `mcp__{serverName}__{toolName}`
 */
export async function executeMcpTool(name, args) {
    // Parse: mcp__{server}__{tool}
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match)
        throw new Error(`Not an MCP tool name: ${name}`);
    const [, serverName, toolName] = match;
    const server = servers.get(serverName);
    if (!server)
        throw new Error(`MCP server "${serverName}" not connected`);
    const result = await server.client.callTool({ name: toolName, arguments: args });
    const content = result.content;
    if (Array.isArray(content)) {
        return content
            .map((c) => (c.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
    }
    return typeof content === 'string' ? content : JSON.stringify(content);
}
/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name) {
    return name.startsWith('mcp__');
}
/**
 * Disconnect all MCP servers.
 */
export async function disconnectAll() {
    for (const [name, server] of servers) {
        try {
            await server.client.close();
        }
        catch { /* ignore */ }
        servers.delete(name);
    }
}
/**
 * Load MCP server configs from a JSON file.
 * Supports both `{ mcpServers: { ... } }` and flat `{ name: { ... } }` format.
 */
export function loadMcpConfig(configPath) {
    if (!existsSync(configPath))
        return {};
    try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        const mcpServers = raw.mcpServers || raw;
        const result = {};
        for (const [name, cfg] of Object.entries(mcpServers)) {
            const c = cfg;
            if (typeof c.autoDetect === 'string') {
                result[name] = { autoDetect: c.autoDetect };
            }
            else if (c.transport === 'http' && typeof c.url === 'string') {
                result[name] = { transport: 'http', url: c.url };
            }
            else if (typeof c.command === 'string') {
                const transport = c.transport === 'http' ? 'http' : 'stdio';
                result[name] = {
                    transport,
                    command: c.command,
                    args: Array.isArray(c.args) ? c.args : undefined,
                    cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
                    env: typeof c.env === 'object' && c.env !== null ? c.env : undefined,
                };
            }
        }
        return result;
    }
    catch {
        return {};
    }
}
// --- Internal ---
async function connectServer(name, cfg) {
    const client = new Client({ name: `trib-orchestrator/${name}`, version: '1.0.0' });
    let transport;
    // Auto-detect: read port from a running service's port file
    if (cfg.autoDetect) {
        const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
        if (!spec)
            throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
        const portFile = join(tmpdir(), spec.dir, spec.file);
        if (!existsSync(portFile)) {
            process.stderr.write(`[mcp-client] "${name}" autoDetect: port file not found (${portFile}), skipping\n`);
            return;
        }
        let port;
        const raw = readFileSync(portFile, 'utf-8').trim();
        if (spec.portField) {
            try {
                const json = JSON.parse(raw);
                port = json[spec.portField];
            }
            catch {
                process.stderr.write(`[mcp-client] "${name}" autoDetect: failed to parse JSON in ${portFile}, skipping\n`);
                return;
            }
        }
        else {
            port = parseInt(raw, 10);
        }
        if (!port || port < 1 || port > 65535) {
            process.stderr.write(`[mcp-client] "${name}" autoDetect: invalid port in ${portFile}, skipping\n`);
            return;
        }
        const url = `http://127.0.0.1:${port}${spec.endpoint}`;
        transport = new StreamableHTTPClientTransport(new URL(url));
        process.stderr.write(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}\n`);
    }
    else if (cfg.transport === 'http' && cfg.url) {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url));
        process.stderr.write(`[mcp-client] Connecting "${name}" via HTTP: ${cfg.url}\n`);
    }
    else if (cfg.command) {
        transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            cwd: cfg.cwd,
            env: { ...process.env, ...cfg.env },
        });
    }
    else {
        throw new Error(`Invalid config for "${name}": need autoDetect, url (http), or command (stdio)`);
    }
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools || []).map((t) => ({
        name: `mcp__${name}__${t.name}`,
        description: t.description ? t.description.slice(0, 2048) : '',
        inputSchema: (t.inputSchema || { type: 'object', properties: {} }),
    }));
    const mode = cfg.autoDetect ? `autoDetect(${cfg.autoDetect})` : cfg.transport || 'stdio';
    servers.set(name, { name, client, transport, tools });
    process.stderr.write(`[mcp-client] Connected "${name}" via ${mode} — ${tools.length} tools\n`);
}
