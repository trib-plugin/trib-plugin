/**
 * Internal tool registry — in-process tools exposed to external LLMs via bridge.
 *
 * Populated by agent/index.mjs.handleToolCall when the server injects a
 * context carrying { toolExecutor, internalTools }. The executor dispatches
 * to the plugin's existing module router (worker IPC for memory/channels,
 * in-process loadModule for search). No MCP loopback, no HTTP hop.
 *
 * Orchestrator modules (session/manager.mjs, session/loop.mjs) import from
 * here instead of going through mcp/client.mjs for internal tools.
 */

let _executor = null;
let _tools = [];
let _names = new Set();

export function setInternalToolsProvider({ executor, tools }) {
    if (typeof executor !== 'function') throw new Error('internal-tools: executor must be a function');
    _executor = executor;
    _tools = Array.isArray(tools) ? [...tools] : [];
    _names = new Set(_tools.map(t => t?.name).filter(Boolean));
}

export function getInternalTools() {
    return _tools;
}

export function isInternalTool(name) {
    return _names.has(name);
}

export async function executeInternalTool(name, args) {
    if (!_executor) throw new Error(`internal-tools: executor not initialized (tool=${name})`);
    if (!_names.has(name)) throw new Error(`internal-tools: "${name}" is not registered`);
    const result = await _executor(name, args ?? {});
    // Mirror executeMcpTool's shape normalization so the session loop sees a
    // plain string either way. Worker/module handlers return the MCP-shaped
    // `{ content: [{type:'text', text}] }` envelope directly.
    if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return result.content
            .map((c) => (c?.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
}

export function hasInternalTools() {
    return _executor !== null && _tools.length > 0;
}
