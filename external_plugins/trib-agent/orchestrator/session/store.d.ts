/**
 * File-based session store.
 * Sessions are saved to disk so CLI and MCP server can share state,
 * and sessions survive server restarts (resume).
 */
import type { Message, ToolDef } from '../providers/base.js';
export interface SessionData {
    id: string;
    provider: string;
    model: string;
    messages: Message[];
    contextWindow: number;
    tools: ToolDef[];
    preset: string;
    agent?: string;
    cwd?: string;
    createdAt: number;
    updatedAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}
export declare function saveSession(session: SessionData): void;
export declare function loadSession(id: string): SessionData | null;
export declare function deleteSession(id: string): boolean;
export declare function listStoredSessions(): SessionData[];
