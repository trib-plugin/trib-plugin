/**
 * OpenAI ChatGPT OAuth (Codex) provider.
 *
 * Uses Codex Responses API (chatgpt.com/backend-api/codex/responses)
 * with SSE streaming. Authenticates via PKCE OAuth or reuses ~/.codex/auth.json.
 */
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getPluginData } from '../config.js';
// --- Constants ---
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CALLBACK_PORT = 1455;
function getOwnTokenPath() {
    const dir = getPluginData();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, 'openai-oauth.json');
}
function loadTokens() {
    // Try Codex CLI format first
    const codexPath = join(homedir(), '.codex', 'auth.json');
    if (existsSync(codexPath)) {
        try {
            const data = JSON.parse(readFileSync(codexPath, 'utf-8'));
            const tokens = data.tokens || data;
            if (tokens.access_token && tokens.refresh_token) {
                const expiresAt = typeof data.expires_at === 'number'
                    ? (data.expires_at < 1e12 ? data.expires_at * 1000 : data.expires_at)
                    : (data.last_refresh ? new Date(data.last_refresh).getTime() + 3600_000 : 0);
                return {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    expires_at: expiresAt,
                    account_id: tokens.account_id || extractAccountId(tokens.access_token),
                };
            }
        }
        catch { /* fall through */ }
    }
    const ownPath = getOwnTokenPath();
    if (!existsSync(ownPath))
        return null;
    try {
        return JSON.parse(readFileSync(ownPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
function saveTokens(tokens) {
    writeFileSync(getOwnTokenPath(), JSON.stringify(tokens, null, 2));
}
function extractAccountId(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        return payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    }
    catch {
        return undefined;
    }
}
// --- Token refresh ---
async function refreshTokens(refreshToken) {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID,
        }),
    });
    if (!res.ok)
        return null;
    const json = await res.json();
    if (!json.access_token || !json.refresh_token || !json.expires_in)
        return null;
    const tokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + json.expires_in * 1000,
        account_id: extractAccountId(json.access_token),
    };
    saveTokens(tokens);
    return tokens;
}
async function parseSSEStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let model = '';
    let toolCalls = [];
    let usage;
    let buffer = '';
    // Track: item_id → { name, call_id } from output_item.added events
    const pendingCalls = new Map();
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data: '))
                continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]')
                continue;
            try {
                const event = JSON.parse(data);
                // Extract text output
                if (event.type === 'response.output_text.delta') {
                    content += event.delta || '';
                }
                // Extract model from response.created
                if (event.type === 'response.created' && event.response?.model) {
                    model = event.response.model;
                }
                // Track tool call info from output_item.added (has name + call_id)
                if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
                    pendingCalls.set(event.item.id || '', {
                        name: event.item.name || '',
                        callId: event.item.call_id || '',
                    });
                }
                // Extract tool calls when arguments are complete (has item_id, NOT call_id/name)
                if (event.type === 'response.function_call_arguments.done') {
                    const itemId = event.item_id || '';
                    const pending = pendingCalls.get(itemId);
                    toolCalls.push({
                        id: pending?.callId || `tc_${Date.now()}_${toolCalls.length}`,
                        name: pending?.name || '',
                        arguments: JSON.parse(event.arguments || '{}'),
                    });
                }
                // Extract usage from response.completed
                if (event.type === 'response.completed' && event.response?.usage) {
                    const u = event.response.usage;
                    usage = {
                        inputTokens: u.input_tokens || 0,
                        outputTokens: u.output_tokens || 0,
                    };
                    if (!model && event.response.model)
                        model = event.response.model;
                    // Also extract final text from output if we missed deltas
                    if (!content && event.response.output) {
                        for (const item of event.response.output) {
                            if (item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text')
                                        content += c.text || '';
                                }
                            }
                        }
                    }
                }
            }
            catch { /* skip malformed events */ }
        }
    }
    return {
        content,
        model,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage,
    };
}
// --- Build Responses API request ---
function buildRequestBody(messages, model, tools, sendOpts) {
    // Extract system/instructions
    const systemMsgs = messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    // Convert messages to Responses API input format
    const input = [];
    for (const m of messages) {
        if (m.role === 'system')
            continue;
        if (m.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output: m.content,
            });
            continue;
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
            // Assistant with tool calls → function_call items
            if (m.content) {
                input.push({ role: 'assistant', content: m.content });
            }
            for (const tc of m.toolCalls) {
                input.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                });
            }
            continue;
        }
        input.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
        });
    }
    const opts = sendOpts || {};
    const body = {
        model,
        instructions,
        input,
        store: false,
        stream: true,
        reasoning: { effort: opts.effort || 'medium' },
    };
    if (opts.fast === true) {
        body.service_tier = 'priority';
    }
    // Add tools
    if (tools?.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        }));
    }
    return body;
}
// --- Provider ---
export class OpenAIOAuthProvider {
    name = 'openai-oauth';
    tokens = null;
    constructor(_config) {
        this.tokens = loadTokens();
    }
    async ensureAuth() {
        if (!this.tokens)
            throw new Error('OpenAI OAuth not authenticated. Run codex login first.');
        // Always refresh if expired or close to expiring (5min buffer)
        if (this.tokens.expires_at < Date.now() + 300_000) {
            process.stderr.write(`[openai-oauth] Token expired/expiring, refreshing...\n`);
            try {
                const refreshed = await refreshTokens(this.tokens.refresh_token);
                if (refreshed) {
                    this.tokens = refreshed;
                    process.stderr.write(`[openai-oauth] Token refreshed, expires in ${Math.round((refreshed.expires_at - Date.now()) / 1000)}s\n`);
                }
                else {
                    throw new Error('refresh returned null');
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[openai-oauth] Refresh failed: ${msg}, re-reading auth files...\n`);
                // Re-read auth files in case user ran codex login
                const reloaded = loadTokens();
                if (reloaded && reloaded.access_token !== this.tokens?.access_token) {
                    this.tokens = reloaded;
                    process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
                    // Retry refresh with new tokens
                    try {
                        const refreshed2 = await refreshTokens(this.tokens.refresh_token);
                        if (refreshed2) { this.tokens = refreshed2; return this.tokens; }
                    } catch { /* fall through */ }
                }
                throw new Error('OpenAI OAuth token refresh failed. Run codex login to re-authenticate.');
            }
        }
        return this.tokens;
    }
    async send(messages, model, tools, sendOpts) {
        const auth = await this.ensureAuth();
        const useModel = model || 'gpt-5.2-codex';
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        const response = await fetch(CODEX_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
                'chatgpt-account-id': auth.account_id || '',
                'originator': 'codex_cli_rs',
                'OpenAI-Beta': 'responses=experimental',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            process.stderr.write(`[openai-oauth] API error ${response.status}: ${text.slice(0, 200)}\n`);
            throw new Error(`Codex API ${response.status}: ${text.slice(0, 200)}`);
        }
        process.stderr.write(`[openai-oauth] Response ${response.status}, parsing SSE...\n`);
        const result = await parseSSEStream(response);
        process.stderr.write(`[openai-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`);
        return result;
    }
    async listModels() {
        return [
            { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai-oauth', contextWindow: 1000000 },
            { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai-oauth', contextWindow: 1000000 },
            { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', provider: 'openai-oauth', contextWindow: 1000000 },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', provider: 'openai-oauth', contextWindow: 1000000 },
            { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai-oauth', contextWindow: 1000000 },
        ];
    }
    async isAvailable() {
        return this.tokens !== null;
    }
}
// --- Login flow (export for CLI use) ---
function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}
export async function loginOAuth() {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'codex_cli_rs');
    process.stderr.write(`\n[openai-oauth] Open this URL to log in:\n${url.toString()}\n\n`);
    try {
        const { exec } = await import('child_process');
        const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${opener} "${url.toString()}"`);
    }
    catch { /* user opens manually */ }
    return new Promise((resolve) => {
        const timeout = setTimeout(() => { server.close(); resolve(null); }, 120_000);
        const server = createServer(async (req, res) => {
            const u = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);
            if (u.pathname !== '/auth/callback') {
                res.writeHead(404);
                res.end();
                return;
            }
            const code = u.searchParams.get('code');
            if (!code || u.searchParams.get('state') !== state) {
                res.writeHead(400);
                res.end('Invalid');
                clearTimeout(timeout);
                server.close();
                resolve(null);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Login successful!</h2></body></html>');
            clearTimeout(timeout);
            server.close();
            // Exchange code for tokens
            const tokenRes = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code', client_id: CLIENT_ID,
                    code, code_verifier: pkce.verifier, redirect_uri: REDIRECT_URI,
                }),
            });
            if (!tokenRes.ok) {
                resolve(null);
                return;
            }
            const json = await tokenRes.json();
            if (!json.access_token || !json.refresh_token) {
                resolve(null);
                return;
            }
            const tokens = {
                access_token: json.access_token, refresh_token: json.refresh_token,
                expires_at: Date.now() + (json.expires_in || 3600) * 1000,
                account_id: extractAccountId(json.access_token),
            };
            saveTokens(tokens);
            resolve(tokens);
        });
        server.listen(CALLBACK_PORT, '127.0.0.1');
        server.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
}
