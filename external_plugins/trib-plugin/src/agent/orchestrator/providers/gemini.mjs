import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAICacheManager } from '@google/generative-ai/server';
import { loadConfig } from '../config.mjs';
import { estimateGeminiTokens, warnBridgeOnce } from '../bridge-trace.mjs';

const MODELS = [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1000000 },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1000000 },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', contextWindow: 1000000 },
];

/**
 * Convert JSON Schema type string to Gemini SchemaType.
 * Gemini SDK uses its own enum instead of plain strings.
 */
function toSchemaType(t) {
    const map = {
        string: SchemaType.STRING,
        number: SchemaType.NUMBER,
        integer: SchemaType.INTEGER,
        boolean: SchemaType.BOOLEAN,
        array: SchemaType.ARRAY,
        object: SchemaType.OBJECT,
    };
    return map[t] ?? SchemaType.STRING;
}

/**
 * Recursively convert a JSON Schema object to Gemini's FunctionDeclarationSchema.
 * Gemini requires `type` to be a SchemaType enum, not a plain string.
 */
function convertSchema(schema) {
    const result = { ...schema };
    if (typeof result.type === 'string') {
        result.type = toSchemaType(result.type);
    }
    if (result.properties && typeof result.properties === 'object') {
        const props = {};
        for (const [key, val] of Object.entries(result.properties)) {
            props[key] = convertSchema(val);
        }
        result.properties = props;
    }
    if (result.items && typeof result.items === 'object') {
        result.items = convertSchema(result.items);
    }
    return result;
}

function toGeminiTools(tools) {
    return {
        functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: convertSchema(t.inputSchema),
        })),
    };
}

function toGeminiContent(message) {
    if (!message || message.role === 'system') return null;
    if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts = [];
        if (message.content) parts.push({ text: message.content });
        for (const tc of message.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
        return { role: 'model', parts };
    }
    if (message.role === 'tool') {
        return {
            role: 'function',
            parts: [{ functionResponse: { name: message.toolCallId || '', response: { result: message.content } } }],
        };
    }
    return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
    };
}

function toGeminiContents(messages) {
    const contents = [];
    for (const message of messages) {
        const content = toGeminiContent(message);
        if (content) contents.push(content);
    }
    return contents;
}

function parseToolCalls(parts) {
    const calls = parts.filter((p) => 'functionCall' in p && !!p.functionCall);
    if (!calls.length)
        return undefined;
    return calls.map((p, i) => ({
        id: `gemini_${Date.now()}_${i}`,
        name: p.functionCall.name,
        arguments: (p.functionCall.args ?? {}),
    }));
}

function buildGeminiCacheFingerprint({ model, systemInstruction, tools, prefixContents }) {
    try {
        return JSON.stringify({
            model,
            systemInstruction: systemInstruction || null,
            tools: tools || null,
            prefixContents,
        });
    }
    catch {
        return '';
    }
}

const GEMINI_CACHE_TTL_MS = 5 * 60 * 1000;
const GEMINI_CACHE_MIN_TOKENS = 1024;

export class GeminiProvider {
    name = 'gemini';
    genAI;
    cacheManager;
    config;
    _geminiSessionCaches = new Map();

    constructor(config) {
        this.config = config;
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.cacheManager = new GoogleAICacheManager(apiKey);
    }

    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.gemini;
            const newKey = cfg?.apiKey || process.env.GEMINI_API_KEY;
            if (newKey) {
                this.genAI = new GoogleGenerativeAI(newKey);
                this.cacheManager = new GoogleAICacheManager(newKey);
                this._geminiSessionCaches.clear();
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

    async _getCachedGeminiModel(sessionId, useModel, systemInstruction, geminiTools, prefixContents, signal) {
        if (!sessionId || prefixContents.length === 0) return null;
        const prefixTokenEstimate = estimateGeminiTokens(prefixContents);
        if (prefixTokenEstimate < GEMINI_CACHE_MIN_TOKENS) return null;

        const now = Date.now();
        const fingerprint = buildGeminiCacheFingerprint({
            model: useModel,
            systemInstruction,
            tools: geminiTools,
            prefixContents,
        });
        const existing = this._geminiSessionCaches.get(sessionId);
        if (existing && existing.fingerprint === fingerprint && (now - existing.createdAt) < GEMINI_CACHE_TTL_MS) {
            return this.genAI.getGenerativeModelFromCachedContent(existing.cachedContent);
        }

        try {
            const cachedContent = await this.cacheManager.create({
                model: useModel,
                contents: prefixContents,
                ttlSeconds: 300,
                ...(geminiTools ? { tools: geminiTools } : {}),
                ...(systemInstruction ? { systemInstruction } : {}),
                displayName: `trib-bridge-${sessionId}`,
            });
            if (signal?.aborted) {
                const reason = signal.reason;
                throw reason instanceof Error ? reason : new Error('Gemini cache creation aborted by session close');
            }
            this._geminiSessionCaches.set(sessionId, {
                cachedContent,
                fingerprint,
                createdAt: now,
            });
            return this.genAI.getGenerativeModelFromCachedContent(cachedContent);
        } catch (err) {
            this._geminiSessionCaches.delete(sessionId);
            warnBridgeOnce(
                `gemini-cache:${sessionId}`,
                `[bridge-cache] gemini cache disabled for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        }
    }

    async _doSend(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('Gemini request aborted by session close');
        }

        const useModel = model || 'gemini-2.5-flash';
        const systemInstruction = messages
            .filter(m => m.role === 'system')
            .map(m => m.content)
            .join('\n\n') || undefined;
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const contents = toGeminiContents(chatMsgs);
        if (!contents.length)
            throw new Error('No messages to send');

        const geminiTools = tools?.length ? [toGeminiTools(tools)] : undefined;
        const requestOpts = signal ? { signal } : undefined;

        let genModel = this.genAI.getGenerativeModel({
            model: useModel,
            systemInstruction,
            tools: geminiTools,
        });
        let requestContents = contents;

        const sessionId = opts.sessionId || null;
        if (sessionId && contents.length > 1) {
            const prefixContents = contents.slice(0, -1);
            const cachedModel = await this._getCachedGeminiModel(
                sessionId,
                useModel,
                systemInstruction,
                geminiTools,
                prefixContents,
                signal,
            );
            if (cachedModel) {
                genModel = cachedModel;
                requestContents = [contents[contents.length - 1]];
            }
        }

        const result = await genModel.generateContent({ contents: requestContents }, requestOpts);
        const response = result.response;
        const textParts = response.candidates?.[0]?.content?.parts?.filter(p => 'text' in p) ?? [];
        const content = textParts.map(p => 'text' in p ? p.text : '').join('');
        const toolCalls = parseToolCalls(response.candidates?.[0]?.content?.parts ?? []);
        return {
            content,
            model: useModel,
            toolCalls,
            usage: response.usageMetadata ? {
                inputTokens: response.usageMetadata.promptTokenCount || 0,
                outputTokens: response.usageMetadata.candidatesTokenCount || 0,
                cachedTokens: response.usageMetadata.cachedContentTokenCount || 0,
            } : undefined,
        };
    }

    async listModels() {
        return MODELS;
    }

    async isAvailable() {
        try {
            const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
            await model.generateContent('hi');
            return true;
        }
        catch {
            return false;
        }
    }
}
