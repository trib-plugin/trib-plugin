import { readFileSync, existsSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { loadGitHubToken } from './providers/copilot-auth.mjs';

/**
 * Resolve CLAUDE_PLUGIN_DATA directory.
 * If the env var is set (MCP server context), use it directly.
 * Otherwise derive from CLAUDE_PLUGIN_ROOT (CLI command context):
 *   CLAUDE_PLUGIN_ROOT = .../marketplaces/{marketplace}/external_plugins/{plugin}
 *   CLAUDE_PLUGIN_DATA = ~/.claude/plugins/data/{plugin}-{marketplace}
 */
export function getPluginData() {
    if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (root) {
        const dirName = basename(root);
        // Cache path: .../cache/{marketplace}/{plugin}/{version}/
        // → basename = version, parent = plugin, grandparent = marketplace
        if (/^\d+\.\d+\.\d+/.test(dirName)) {
            const pluginName = basename(join(root, '..'));
            const marketplace = basename(join(root, '..', '..'));
            return join(homedir(), '.claude', 'plugins', 'data', `${pluginName}-${marketplace}`);
        }
        // Marketplace path: .../marketplaces/{marketplace}/external_plugins/{plugin}/
        const marketplace = basename(join(root, '..', '..'));
        return join(homedir(), '.claude', 'plugins', 'data', `${dirName}-${marketplace}`);
    }
    return join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
}
const ENV_KEY_MAP = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
};
// Canonical maintenance defaults. Single source of truth — imported by
// llm/index.mjs and setup-server.mjs so UI/runtime cannot drift from config.
export const DEFAULT_MAINTENANCE = Object.freeze({
    defaultPreset: 'gpt5.4-mini',
    cycle1: 'gpt5.4-mini',
    cycle2: 'GPT5.4',
    reason: 'sonnet-mid',
});
function buildDefaultConfig() {
    const providers = {};
    // API providers — enabled if env key exists
    for (const [name, envKey] of Object.entries(ENV_KEY_MAP)) {
        const apiKey = process.env[envKey];
        providers[name] = {
            enabled: !!apiKey,
            apiKey: apiKey || undefined,
        };
    }
    // Copilot — enabled if GITHUB_TOKEN env var or hosts.json/apps.json exists
    providers.copilot = {
        enabled: !!loadGitHubToken(),
        baseURL: 'https://api.githubcopilot.com',
    };
    // OpenAI OAuth (ChatGPT subscription) — enabled if ~/.codex/auth.json or own tokens exist
    const hasCodexAuth = existsSync(join(homedir(), '.codex', 'auth.json'));
    const hasOwnAuth = existsSync(join(getPluginData(), 'openai-oauth.json'));
    providers['openai-oauth'] = { enabled: hasCodexAuth || hasOwnAuth };
    // Local providers — opt-in via setup UI after HTTP ping confirms server is running
    providers.ollama = { enabled: false, baseURL: 'http://localhost:11434/v1' };
    providers.lmstudio = { enabled: false, baseURL: 'http://localhost:1234/v1' };
    return { providers };
}
/**
 * One-time migration: if a legacy mcp-tools.json sits next to config.json,
 * merge its `mcpServers` into config.json and rename the legacy file to .bak.
 * Skipped silently if config.json already has `mcpServers`.
 */
function migrateMcpToolsFile(configPath) {
    const dir = dirname(configPath);
    const legacyPath = join(dir, 'mcp-tools.json');
    if (!existsSync(legacyPath))
        return;
    let configRaw = {};
    try {
        configRaw = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    catch {
        // config.json malformed; bail without touching legacy file
        return;
    }
    if (configRaw.mcpServers && Object.keys(configRaw.mcpServers).length > 0) {
        // Already migrated — leave the legacy file alone for the user to clean up
        return;
    }
    let legacyRaw = {};
    try {
        legacyRaw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    }
    catch {
        return;
    }
    const legacyServers = legacyRaw.mcpServers || legacyRaw;
    if (!legacyServers || typeof legacyServers !== 'object' || Object.keys(legacyServers).length === 0) {
        return;
    }
    configRaw.mcpServers = legacyServers;
    try {
        mkdirSync(dirname(configPath), { recursive: true });
        const tmp = configPath + '.tmp';
        writeFileSync(tmp, JSON.stringify(configRaw, null, 2) + '\n', 'utf-8');
        renameSync(tmp, configPath);
        renameSync(legacyPath, legacyPath + '.bak');
        process.stderr.write(`[trib-agent] Migrated mcp-tools.json -> config.json (backup at ${legacyPath}.bak)\n`);
    }
    catch (err) {
        process.stderr.write(`[trib-agent] mcp-tools.json migration failed: ${err}\n`);
    }
}
function getConfigPath() {
    return join(getPluginData(), 'agent-config.json');
}
export function loadConfig() {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
        migrateMcpToolsFile(configPath);
        try {
            let raw = JSON.parse(readFileSync(configPath, 'utf-8'));
            // If config has an 'agent' section, use it (unified config format)
            if (raw.agent && raw.agent.providers) {
                raw = raw.agent;
            }
            // user-workflow.json is managed by setup UI; no auto-seeding here
            const defaults = buildDefaultConfig();
            // Deep-merge provider subkeys: unknown per-provider values are
            // preserved through save/load so future fields round-trip
            // without schema updates here.
            const mergedProviders = { ...defaults.providers };
            if (raw.providers && typeof raw.providers === 'object') {
                for (const [name, val] of Object.entries(raw.providers)) {
                    if (val && typeof val === 'object') {
                        mergedProviders[name] = { ...(mergedProviders[name] || {}), ...val };
                    } else {
                        mergedProviders[name] = val;
                    }
                }
            }
            return {
                providers: mergedProviders,
                mcpServers: raw.mcpServers || {},
                presets: Array.isArray(raw.presets) ? raw.presets : [],
                default: raw.default || null,
                maintenance: { ...DEFAULT_MAINTENANCE, ...raw.maintenance },
                agentMaintenance: { enabled: true, interval: '1h', ...raw.agentMaintenance },
                trajectory: { enabled: true, ...raw.trajectory },
                skillSuggest: { autoDetect: true, ...raw.skillSuggest },
                // Top-level extension blocks preserved through save/load so
                // future keys round-trip without schema updates here.
                bridge: raw.bridge && typeof raw.bridge === 'object' ? raw.bridge : {},
            };
        }
        catch { /* fall through */ }
    }
    const defaults = buildDefaultConfig();
    return {
        ...defaults,
        mcpServers: {},
        presets: [],
        default: null,
        maintenance: { ...DEFAULT_MAINTENANCE },
        agentMaintenance: { enabled: true, interval: '1h' },
        trajectory: { enabled: true },
        skillSuggest: { autoDetect: true },
        bridge: {},
    };
}
/**
 * Atomically save config.json. Caller passes the full config object.
 * Only persists mcpServers, presets, default, and user-set provider entries
 * (apiKey, enabled, baseURL) — defaults are recomputed on next load.
 */
export function saveConfig(config) {
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    // Strip ephemeral defaults from providers but preserve any unknown
    // per-provider subkey so future schema additions round-trip through
    // the setup UI without changes here.
    const KNOWN_PROVIDER_KEYS = new Set(['apiKey', 'enabled', 'baseURL']);
    const persistedProviders = {};
    if (config.providers) {
        for (const [name, val] of Object.entries(config.providers)) {
            if (!val || typeof val !== 'object') continue;
            const slim = {};
            if (val.apiKey) slim.apiKey = val.apiKey;
            if (typeof val.enabled === 'boolean') slim.enabled = val.enabled;
            if (val.baseURL) slim.baseURL = val.baseURL;
            for (const [k, v] of Object.entries(val)) {
                if (KNOWN_PROVIDER_KEYS.has(k)) continue;
                if (v === undefined) continue;
                slim[k] = v;
            }
            if (Object.keys(slim).length)
                persistedProviders[name] = slim;
        }
    }
    const payload = {
        guide: config.guide || undefined,
        providers: persistedProviders,
        mcpServers: config.mcpServers || {},
        presets: Array.isArray(config.presets) ? config.presets : [],
        default: config.default || null,
        maintenance: config.maintenance || {},
        agentMaintenance: config.agentMaintenance || {},
        trajectory: config.trajectory || {},
        skillSuggest: config.skillSuggest || {},
        bridge: config.bridge || {},
    };
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
}
// --- Preset helpers ---
// preset shape: { id, name, type, provider?, model, effort?, fast?, tools? }
// type: "native" (Claude Code native) or "bridge" (external model via bridge tool)
// native presets have no provider (spawned via Agent tool with model param)
function presetKey(p) { return p?.name || p?.id || ''; }
function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object')
        return null;
    const id = String(preset.id || preset.name || '').trim();
    const name = String(preset.name || preset.id || '').trim();
    const type = preset.type === 'native' ? 'native' : 'bridge';
    const model = String(preset.model || '').trim();
    if (!name || !model)
        return null;
    const out = { id, name, type, model };
    // provider is required for bridge, optional for native
    const provider = String(preset.provider || '').trim();
    if (provider) out.provider = provider;
    if (type === 'bridge' && !provider) return null;
    if (preset.effort)
        out.effort = String(preset.effort).trim();
    if (preset.fast === true)
        out.fast = true;
    out.tools = ['full', 'readonly', 'mcp'].includes(preset.tools) ? preset.tools : 'full';
    return out;
}
export function getPreset(config, key) {
    const presets = Array.isArray(config?.presets) ? config.presets : [];
    if (key == null || key === '')
        return null;
    // Numeric → index
    if (typeof key === 'number' || /^\d+$/.test(String(key))) {
        const idx = Number(key);
        return presets[idx] || null;
    }
    // String → name or id match
    return presets.find(p => p && presetKey(p) === key) || null;
}
export function getDefaultPreset(config) {
    if (!config?.default)
        return null;
    return getPreset(config, config.default);
}
export function listPresets(config) {
    return Array.isArray(config?.presets) ? config.presets : [];
}
// --- Lane-scoped runtime spec ---
// Converts a preset + execution context into a scopeKey for session isolation.
//   bridge lane: "bridge:<presetName>"      — user-facing, reusable per preset
//   bridge lane: "bridge:<agentId>:<presetName>" — per bridge agent instance
export function resolveRuntimeSpec(preset, ctx) {
    const lane = ctx.lane || 'bridge';
    const presetName = preset.name || preset.id;
    let scopeKey;
    if (lane === 'bridge') {
        if (!ctx.agentId) throw new Error('bridge lane requires agentId');
        scopeKey = `bridge:${ctx.agentId}:${presetName}`;
    } else {
        scopeKey = `bridge:${presetName}`;
    }
    return { lane, scopeKey, reuse: true, preset };
}

export function setDefaultPreset(config, key) {
    const preset = getPreset(config, key);
    if (!preset)
        throw new Error(`preset "${key}" not found`);
    config.default = presetKey(preset);
    saveConfig(config);
    return preset;
}
