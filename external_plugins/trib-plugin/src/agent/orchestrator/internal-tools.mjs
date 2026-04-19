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

// Per-tool executor overrides. Populated by addInternalTools() for synthetic
// Pool C tools (memory_search / web_search) that bypass the main dispatch
// (tools.json + dispatchTool) and route directly to a native handler.
const _overrides = new Map();

export function setInternalToolsProvider({ executor, tools }) {
    if (typeof executor !== 'function') throw new Error('internal-tools: executor must be a function');
    _executor = executor;
    _tools = Array.isArray(tools) ? [...tools] : [];
    _names = new Set(_tools.map(t => t?.name).filter(Boolean));
}

/**
 * Register additional tools that aren't declared in tools.json — each comes
 * with its own executor. Used by the Pool C wiring to expose memory_search /
 * web_search without making them public MCP tools.
 *
 * Re-registration is idempotent; later calls overwrite earlier entries with
 * the same name.
 */
export function addInternalTools(extraTools) {
    if (!Array.isArray(extraTools)) return;
    for (const entry of extraTools) {
        if (!entry || typeof entry !== 'object') continue;
        const def = entry.def || entry;
        const exec = typeof entry.executor === 'function' ? entry.executor : null;
        if (!def || !def.name || !exec) continue;
        // Swap any existing entry with the same name.
        _tools = _tools.filter(t => t?.name !== def.name);
        _tools.push({
            name: def.name,
            description: typeof def.description === 'string' ? def.description.slice(0, 2048) : '',
            inputSchema: def.inputSchema || { type: 'object', properties: {} },
            annotations: def.annotations || {},
        });
        _names.add(def.name);
        _overrides.set(def.name, exec);
    }
}

export function getInternalTools() {
    return _tools;
}

export function isInternalTool(name) {
    return _names.has(name);
}

export async function executeInternalTool(name, args) {
    if (!_names.has(name)) throw new Error(`internal-tools: "${name}" is not registered`);
    const override = _overrides.get(name);
    if (override) {
        const result = await override(args ?? {});
        return _normalize(result);
    }
    if (!_executor) throw new Error(`internal-tools: executor not initialized (tool=${name})`);
    const result = await _executor(name, args ?? {});
    return _normalize(result);
}

// Mirror executeMcpTool's shape normalization so the session loop sees a
// plain string either way. Worker/module handlers return the MCP-shaped
// `{ content: [{type:'text', text}] }` envelope directly.
function _normalize(result) {
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
