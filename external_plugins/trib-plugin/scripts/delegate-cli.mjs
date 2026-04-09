#!/usr/bin/env node
/**
 * delegate-cli.mjs — Standalone delegate script for Agent → Bash pattern.
 * Reuses trib-agent's provider registry and session manager.
 *
 * Usage:
 *   node delegate-cli.mjs --provider openai-oauth --model gpt-5.4 "task prompt"
 *   node delegate-cli.mjs --session sess_1 "follow-up prompt"
 *   node delegate-cli.mjs --preset GPT5.4 "task prompt"
 *
 * Output: JSON { sessionId, content, usage } to stdout
 */

import { initProviders } from '../src/agent/orchestrator/providers/registry.js';
import { createSession, askSession, resumeSession } from '../src/agent/orchestrator/session/manager.js';
import { loadConfig, getPluginData } from '../src/agent/orchestrator/config.js';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { request as httpRequest } from 'http';

// --- Parse args ---
const args = process.argv.slice(2);
let provider = null, model = null, sessionId = null, presetName = null;
let context = null, role = null, background = false;
const positional = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--provider' && args[i + 1]) { provider = args[++i]; continue; }
  if (a === '--model' && args[i + 1]) { model = args[++i]; continue; }
  if (a === '--session' && args[i + 1]) { sessionId = args[++i]; continue; }
  if (a === '--preset' && args[i + 1]) { presetName = args[++i]; continue; }
  if (a === '--context' && args[i + 1]) { context = args[++i]; continue; }
  if (a === '--role' && args[i + 1]) { role = args[++i]; continue; }
  if (a === '--background') { background = true; continue; }
  positional.push(a);
}

const task = positional.join(' ');
if (!task) { process.stderr.write('Usage: delegate-cli.mjs [--provider X --model Y | --preset Z | --session S] "task"\n'); process.exit(1); }

// --- Init ---
const config = loadConfig();
await initProviders(config.providers);

// --- Resolve session ---
let session;
if (sessionId) {
  session = resumeSession(sessionId);
  if (!session) { console.error(`Session "${sessionId}" not found`); process.exit(1); }
} else {
  // Resolve preset if given
  let resolvedProvider = provider;
  let resolvedModel = model;
  if (presetName && config.presets) {
    const preset = config.presets.find(p => p.id === presetName || p.name === presetName);
    if (preset) {
      resolvedProvider = resolvedProvider || preset.provider;
      resolvedModel = resolvedModel || preset.model;
    }
  }
  // Fallback to default preset
  if (!resolvedProvider && !resolvedModel && config.default && config.presets) {
    const def = config.presets.find(p => p.id === config.default || p.name === config.default);
    if (def) { resolvedProvider = def.provider; resolvedModel = def.model; }
  }
  if (!resolvedProvider || !resolvedModel) {
    console.error('provider and model required (use --provider/--model, --preset, or set default in config)');
    process.exit(1);
  }
  session = createSession({ provider: resolvedProvider, model: resolvedModel, agent: role, preset: 'full' });
}

// --- Execute ---
// 401 retry is handled by each provider's send() wrapper (OpenAIOAuthProvider,
// AnthropicProvider, GeminiProvider, OpenAICompatProvider all retry on 401/403).
const startedAt = Date.now();
try {
  const result = await askSession(session.id, task, context);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const inTok = result.usage?.inputTokens || 0;
  const outTok = result.usage?.outputTokens || 0;
  const loopNote = result.iterations > 1 ? ` · ${result.iterations} loops` : '';

  const output = {
    sessionId: session.id,
    content: result.content,
    usage: `${elapsed}s · ${inTok} in · ${outTok} out${loopNote}`,
  };

  // stdout = result for Bash tool
  console.log(JSON.stringify(output, null, 2));

  // Background mode: also inject via trib-plugin HTTP
  if (background) {
    await injectResult(`**[${session.provider}/${session.model}]** (${elapsed}s)\n\n${result.content}\n\n---\n_session: ${session.id} · ${inTok} in · ${outTok} out${loopNote}_`, { type: 'delegate' });
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ error: msg }));
  if (background) {
    await injectResult(`**[${session.provider}/${session.model}]** FAILED\n\n${msg}`, { type: 'delegate' });
  }
  process.exit(1);
}

// --- HTTP inject helper ---
function injectResult(content, { type } = {}) {
  return new Promise((resolve) => {
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const portFile = join(tmpDir, 'trib-plugin', 'active-instance.json');
      const instance = JSON.parse(readFileSync(portFile, 'utf8'));
      if (!instance.httpPort) { resolve(); return; }
      const body = { content, source: 'trib-agent' };
      if (type) body.type = type;
      const payload = JSON.stringify(body);
      const req = httpRequest({
        hostname: '127.0.0.1', port: instance.httpPort, path: '/inject',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.end(payload);
    } catch { resolve(); }
  });
}
