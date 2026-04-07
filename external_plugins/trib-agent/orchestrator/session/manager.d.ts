import type { ProviderResponse } from '../providers/base.js';
import { type SessionData } from './store.js';
type ToolPreset = 'full' | 'readonly' | 'mcp';
export type { SessionData } from './store.js';
export declare function createSession(opts: {
    provider: string;
    model: string;
    systemPrompt?: string;
    agent?: string;
    preset?: ToolPreset;
    files?: Array<{
        path: string;
        content: string;
    }>;
    cwd?: string;
}): SessionData;
export interface AskResult extends ProviderResponse {
    trimmed: boolean;
    messagesDropped: number;
    iterations: number;
    toolCallsTotal: number;
}
export declare function askSession(sessionId: string, prompt: string, context?: string, onToolCall?: (iteration: number, calls: Array<{
    id: string;
    name: string;
}>) => void, cwdOverride?: string): Promise<AskResult>;
export declare function resumeSession(sessionId: string, preset?: ToolPreset): SessionData | null;
export declare function getSession(id: string): SessionData | null;
export declare function listSessions(): SessionData[];
export declare function closeSession(id: string): boolean;
