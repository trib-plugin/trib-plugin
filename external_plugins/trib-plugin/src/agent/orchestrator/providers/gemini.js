import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { loadConfig } from '../config.js';
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
function toGeminiHistory(messages) {
    const contents = [];
    for (const m of messages) {
        if (m.role === 'system')
            continue;
        if (m.role === 'assistant' && m.toolCalls?.length) {
            const parts = [];
            if (m.content)
                parts.push({ text: m.content });
            for (const tc of m.toolCalls) {
                parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
            }
            contents.push({ role: 'model', parts });
            continue;
        }
        if (m.role === 'tool') {
            contents.push({
                role: 'function',
                parts: [{ functionResponse: { name: m.toolCallId || '', response: { result: m.content } } }],
            });
            continue;
        }
        contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        });
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
export class GeminiProvider {
    name = 'gemini';
    genAI;
    config;
    constructor(config) {
        this.config = config;
        this.genAI = new GoogleGenerativeAI(config.apiKey || process.env.GEMINI_API_KEY || '');
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.gemini;
            const newKey = cfg?.apiKey || process.env.GEMINI_API_KEY;
            if (newKey) {
                this.genAI = new GoogleGenerativeAI(newKey);
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools) {
        try {
            return await this._doSend(messages, model, tools);
        } catch (err) {
            if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
                process.stderr.write(`[provider] Auth error, re-reading config...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools);
            }
            throw err;
        }
    }
    async _doSend(messages, model, tools) {
        const useModel = model || 'gemini-2.5-flash';
        const systemMsgs = messages.filter(m => m.role === 'system');
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const genModel = this.genAI.getGenerativeModel({
            model: useModel,
            systemInstruction: systemMsgs.map(m => m.content).join('\n\n') || undefined,
            tools: tools?.length ? [toGeminiTools(tools)] : undefined,
        });
        const history = toGeminiHistory(chatMsgs.slice(0, -1));
        const lastMsg = chatMsgs[chatMsgs.length - 1];
        if (!lastMsg)
            throw new Error('No messages to send');
        const chat = genModel.startChat({ history });
        // Last message could be a function response or text
        let lastParts;
        if (lastMsg.role === 'tool') {
            lastParts = [{ functionResponse: { name: lastMsg.toolCallId || '', response: { result: lastMsg.content } } }];
        }
        else {
            lastParts = [{ text: lastMsg.content }];
        }
        const result = await chat.sendMessage(lastParts);
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
