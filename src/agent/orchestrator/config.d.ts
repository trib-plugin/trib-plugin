import type { ProvidersConfig } from './providers/base.js';
import type { McpServerConfig } from './mcp/client.js';
export interface Config {
    providers: ProvidersConfig;
    mcpServers?: Record<string, McpServerConfig>;
}
export declare function loadConfig(): Config;
