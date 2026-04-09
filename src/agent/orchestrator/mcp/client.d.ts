import type { ToolDef } from '../providers/base.js';
export interface McpServerConfig {
    transport?: 'stdio' | 'http';
    /** HTTP transport: server URL (e.g. http://127.0.0.1:3350/mcp) */
    url?: string;
    /** Auto-detect: read port from a known service's port file */
    autoDetect?: string;
    /** stdio transport: command to spawn */
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
}
/**
 * Connect to MCP servers defined in config.
 * Supports stdio (child process) and http (Streamable HTTP) transports.
 */
export declare function connectMcpServers(config: Record<string, McpServerConfig>): Promise<void>;
/**
 * Get all tool definitions from connected MCP servers.
 * Tool names are prefixed: `mcp__{serverName}__{toolName}`
 */
export declare function getMcpTools(): ToolDef[];
/**
 * Execute an MCP tool call.
 * Name format: `mcp__{serverName}__{toolName}`
 */
export declare function executeMcpTool(name: string, args: Record<string, unknown>): Promise<string>;
/**
 * Check if a tool name is an MCP tool.
 */
export declare function isMcpTool(name: string): boolean;
/**
 * Disconnect all MCP servers.
 */
export declare function disconnectAll(): Promise<void>;
/**
 * Load MCP server configs from a JSON file.
 * Supports both `{ mcpServers: { ... } }` and flat `{ name: { ... } }` format.
 */
export declare function loadMcpConfig(configPath: string): Record<string, McpServerConfig>;
