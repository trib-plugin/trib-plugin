import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.mjs';
const MODELS = [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 1000000 },
    { id: 'claude-opus-4-0', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200000 },
    { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000 },
];
const MAX_TOKENS = {
    'claude-opus-4-6': 32768,
    'claude-opus-4-0': 32768,
    'claude-sonnet-4-0': 16384,
    'claude-haiku-4-5-20251001': 8192,
};
// Effort → thinking budget tokens (Anthropic extended thinking)
const EFFORT_BUDGET = {
    low: 1024,
    medium: 4096,
    high: 16384,
    max: 32768,
};
function toAnthropicTools(tools) {
    return tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    }));
}
function toAnthropicMessages(messages) {
    const result = [];
    for (const m of messages) {
        if (m.role === 'system')
            continue; // handled separately
        if (m.role === 'assistant' && m.toolCalls?.length) {
            // Assistant message with tool use blocks
            const content = [];
            if (m.content)
                content.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls) {
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.arguments,
                });
            }
            result.push({ role: 'assistant', content });
            continue;
        }
        if (m.role === 'tool') {
            // Tool results must be in a user message with tool_result blocks
            // Group consecutive tool messages into one user message
            const last = result[result.length - 1];
            const block = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: m.content,
            };
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
            }
            else {
                result.push({ role: 'user', content: [block] });
            }
            continue;
        }
        result.push({
            role: m.role,
            content: m.content,
        });
    }
    return result;
}
function parseToolCalls(response) {
    const blocks = response.content.filter((b) => b.type === 'tool_use');
    if (!blocks.length)
        return undefined;
    return blocks.map((b) => ({
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}),
    }));
}
export class AnthropicProvider {
    name = 'anthropic';
    client;
    config;
    constructor(config) {
        this.config = config;
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
        });
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.anthropic;
            const newKey = cfg?.apiKey || process.env.ANTHROPIC_API_KEY;
            if (newKey) {
                this.client = new Anthropic({ apiKey: newKey });
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools, sendOpts) {
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
                process.stderr.write(`[provider] Auth error, re-reading config...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }
    async _doSend(messages, model, tools, sendOpts) {
        const useModel = model || 'claude-sonnet-4-0';
        const maxTokens = MAX_TOKENS[useModel] || 8192;
        const opts = sendOpts || {};
        const systemMsgs = messages.filter(m => m.role === 'system');
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const params = {
            model: useModel,
            max_tokens: maxTokens,
            system: systemMsgs.map(m => m.content).join('\n\n') || undefined,
            messages: toAnthropicMessages(chatMsgs),
        };
        if (tools?.length) {
            params.tools = toAnthropicTools(tools);
        }
        // Effort → extended thinking budget
        if (opts.effort && EFFORT_BUDGET[opts.effort]) {
            params.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[opts.effort] };
        }
        // Fast mode → speed: "fast" (Opus 4.6 only, infrastructure priority routing)
        const extraHeaders = {};
        if (opts.fast === true) {
            params.speed = 'fast';
        }
        const response = await this.client.messages.create(params, { headers: extraHeaders });
        const textBlock = response.content.find(b => b.type === 'text');
        const toolCalls = parseToolCalls(response);
        return {
            content: textBlock?.type === 'text' ? textBlock.text : '',
            model: response.model,
            toolCalls,
            usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
            },
        };
    }
    async listModels() {
        return MODELS;
    }
    async isAvailable() {
        try {
            await this.client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }],
            });
            return true;
        }
        catch {
            return false;
        }
    }
}
