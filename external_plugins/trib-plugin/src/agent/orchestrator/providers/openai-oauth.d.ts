/**
 * OpenAI ChatGPT OAuth (Codex) provider.
 *
 * Uses Codex Responses API (chatgpt.com/backend-api/codex/responses)
 * with SSE streaming. Authenticates via PKCE OAuth or reuses ~/.codex/auth.json.
 */
import type { Message, ModelInfo, Provider, ProviderConfig, ProviderResponse, ToolDef } from './base.js';
interface StoredTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    account_id?: string;
}
export declare class OpenAIOAuthProvider implements Provider {
    readonly name = "openai-oauth";
    private tokens;
    constructor(_config?: ProviderConfig);
    private ensureAuth;
    send(messages: Message[], model?: string, tools?: ToolDef[]): Promise<ProviderResponse>;
    listModels(): Promise<ModelInfo[]>;
    isAvailable(): Promise<boolean>;
}
export declare function loginOAuth(): Promise<StoredTokens | null>;
export {};
