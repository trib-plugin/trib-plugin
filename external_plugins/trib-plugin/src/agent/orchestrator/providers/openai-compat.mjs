import OpenAI from 'openai';
import { loadConfig } from '../config.mjs';
const PRESETS = {
    openai: {
        baseURL: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
    },
    groq: {
        baseURL: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
    },
    openrouter: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultModel: 'anthropic/claude-sonnet-4',
        extraHeaders: { 'HTTP-Referer': 'trib-agent', 'X-Title': 'trib-agent' },
    },
    xai: {
        baseURL: 'https://api.x.ai/v1',
        defaultModel: 'grok-3-beta',
    },
    ollama: {
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.3:latest',
    },
    lmstudio: {
        baseURL: 'http://localhost:1234/v1',
        defaultModel: 'default',
    },
    local: {
        baseURL: 'http://localhost:8080/v1',
        defaultModel: 'default',
    },
};
function toOpenAIMessages(messages) {
    return messages.map((m) => {
        if (m.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: m.toolCallId || '',
                content: m.content,
            };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
            };
        }
        return { role: m.role, content: m.content };
    });
}
function toOpenAITools(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));
}
function parseToolCalls(choice) {
    const calls = choice.message?.tool_calls;
    if (!calls?.length)
        return undefined;
    return calls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
}
export class OpenAICompatProvider {
    name;
    client;
    defaultModel;
    config;
    constructor(name, config) {
        const preset = PRESETS[name];
        const baseURL = config.baseURL || preset?.baseURL || 'http://localhost:8080/v1';
        const apiKey = config.apiKey || 'no-key';
        this.name = name;
        this.config = config;
        this.defaultModel = preset?.defaultModel || 'default';
        this.client = new OpenAI({
            baseURL,
            apiKey,
            defaultHeaders: preset?.extraHeaders,
        });
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.[this.name];
            const preset = PRESETS[this.name];
            const newKey = cfg?.apiKey || this.config.apiKey;
            const baseURL = cfg?.baseURL || this.config.baseURL || preset?.baseURL || 'http://localhost:8080/v1';
            if (newKey) {
                this.client = new OpenAI({
                    baseURL,
                    apiKey: newKey,
                    defaultHeaders: preset?.extraHeaders,
                });
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
        const useModel = model || this.defaultModel;
        const opts = sendOpts || {};
        const params = {
            model: useModel,
            messages: toOpenAIMessages(messages),
        };
        if (tools?.length) {
            params.tools = toOpenAITools(tools);
        }
        // Apply effort/fast only on the official OpenAI endpoint — other compat
        // providers (groq, ollama, lmstudio, openrouter, xai) ignore these.
        if (this.name === 'openai') {
            if (opts.effort) {
                // OpenAI Chat Completions takes a flat string field.
                params.reasoning_effort = opts.effort;
            }
            if (opts.fast === true) {
                params.service_tier = 'priority';
            }
        }
        const response = await this.client.chat.completions.create(params);
        const choice = response.choices[0];
        const toolCalls = choice ? parseToolCalls(choice) : undefined;
        return {
            content: choice?.message?.content || '',
            model: response.model,
            toolCalls,
            usage: response.usage ? {
                inputTokens: response.usage.prompt_tokens || 0,
                outputTokens: response.usage.completion_tokens || 0,
            } : undefined,
        };
    }
    async listModels() {
        try {
            const list = await this.client.models.list();
            const models = [];
            for await (const m of list) {
                models.push({
                    id: m.id,
                    name: m.id,
                    provider: this.name,
                    contextWindow: 0,
                });
            }
            return models;
        }
        catch {
            return [];
        }
    }
    async isAvailable() {
        try {
            await this.client.models.list();
            return true;
        }
        catch {
            return false;
        }
    }
}
