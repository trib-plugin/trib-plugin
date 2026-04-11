import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
// --- Types ---
/** Known auto-detect targets: port file path relative to tmpdir */
const AUTO_DETECT_PORTS = {
    'trib-memory': { dir: 'trib-memory', file: 'memory-port', endpoint: '/mcp' },
    'trib-plugin': { dir: 'trib-plugin', file: 'active-instance.json', endpoint: '/mcp', portField: 'httpPort' },
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
    let result;
    try {
        result = await server.client.callTool({ name: toolName, arguments: args });
    } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        process.stderr.write(`[mcp-client] Tool call failed, attempting reconnect...\n`);
        await new Promise(r => setTimeout(r, 500));
        try {
            await server.client.close();
        } catch { /* ignore close error */ }
        try {
            await connectServer(serverName, server.cfg);
        } catch (reconnectErr) {
            const reconnectMsg = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
            throw new Error(`Tool call failed: ${firstMsg}; reconnect also failed: ${reconnectMsg}`);
        }
        const retryServer = servers.get(serverName);
        try {
            result = await retryServer.client.callTool({ name: toolName, arguments: args });
        } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new Error(`Tool call failed: ${firstMsg}; retry after reconnect also failed: ${retryMsg}`);
        }
    }
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
            if (typeof c.pluginCache === 'string') {
                result[name] = { pluginCache: c.pluginCache, script: c.script };
            }
            else if (typeof c.autoDetect === 'string') {
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
function resolvePluginCacheScript(pluginName, script) {
    const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'trib-plugin', pluginName);
    if (existsSync(cacheBase)) {
        const versions = readdirSync(cacheBase).filter(d => /^\d+\.\d+\.\d+/.test(d)).sort((a, b) => {
            const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
            return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
        });
        for (let i = versions.length - 1; i >= 0; i--) {
            const version = versions[i];
            const dir = join(cacheBase, version);
            const scriptPath = join(dir, script);
            if (existsSync(scriptPath)) {
                return { dir, scriptPath, source: `pluginCache:${pluginName}@${version}` };
            }
        }
    }
    const marketplaceDir = join(homedir(), '.claude', 'plugins', 'marketplaces', 'trib-plugin', 'external_plugins', pluginName);
    const marketplaceScript = join(marketplaceDir, script);
    if (existsSync(marketplaceScript)) {
        return { dir: marketplaceDir, scriptPath: marketplaceScript, source: `marketplace:${pluginName}` };
    }
    return null;
}

async function connectServer(name, cfg) {
    const client = new Client({ name: `trib-agent/${name}`, version: '1.0.0' });
    let transport;
    // pluginCache: resolve latest cached plugin version as stdio transport
    if (cfg.pluginCache) {
        const script = cfg.script || 'scripts/run-mcp.mjs';
        const resolved = resolvePluginCacheScript(cfg.pluginCache, script);
        if (!resolved) throw new Error(`Script not found for pluginCache "${cfg.pluginCache}" (${script})`);
        transport = new StdioClientTransport({
            command: 'node',
            args: [resolved.scriptPath],
            cwd: resolved.dir,
            env: {
                ...process.env,
                CLAUDE_PLUGIN_ROOT: resolved.dir,
                CLAUDE_PLUGIN_DATA: join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin'),
            },
        });
        process.stderr.write(`[mcp-client] Connecting "${name}" via ${resolved.source}\n`);
    }
    // Auto-detect: read port from a running service's port file
    else if (cfg.autoDetect) {
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
    const mode = cfg.pluginCache ? `pluginCache(${cfg.pluginCache})` : cfg.autoDetect ? `autoDetect(${cfg.autoDetect})` : cfg.transport || 'stdio';
    servers.set(name, { name, client, transport, tools, cfg });
    process.stderr.write(`[mcp-client] Connected "${name}" via ${mode} — ${tools.length} tools\n`);
}
