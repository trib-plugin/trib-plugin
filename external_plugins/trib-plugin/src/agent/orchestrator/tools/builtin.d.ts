import type { ToolDef } from '../providers/base.js';
export declare const BUILTIN_TOOLS: ToolDef[];
export declare function executeBuiltinTool(name: string, args: Record<string, unknown>, cwd?: string): string;
/**
 * Check if a tool name is a builtin tool.
 */
export declare function isBuiltinTool(name: string): boolean;
