/**
 * state-packet.mjs — Structured state packet extraction and session injection.
 *
 * Summarizes recent session messages into a compact, structured state packet
 * using an LLM, then injects the packet into new or resuming sessions so they
 * inherit prior context without carrying the full conversation history.
 */

import { callLLM } from '../../../shared/llm/index.mjs';
import { loadConfig, getPluginData } from '../config.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

// ── Constants ────────────────────────────────────────────────────────

const MAX_MESSAGES_FOR_EXTRACTION = 40;
const MAX_CONTENT_PER_MESSAGE = 600;
const PACKET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PACKET_DIR = join(getPluginData(), 'state-packets');


// ── Prompt ────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Analyze the conversation and extract a structured state packet. Return ONLY valid JSON (no markdown fences) with this exact structure:
{
  "goal": "What the user is trying to accomplish",
  "constraints": ["List of constraints, preferences, and rules"],
  "progress": {
    "done": ["Completed items with specifics"],
    "inProgress": ["Currently active work"],
    "blocked": ["Blockers or open issues"]
  },
  "keyDecisions": ["Important decisions made and why"],
  "relevantFiles": ["File paths mentioned or modified"],
  "nextSteps": ["What needs to happen next"],
  "criticalContext": ["Specific values, error messages, config details that must not be lost"]
}
Omit empty arrays. Be concise but preserve critical details.

Messages:
{{MESSAGES}}`;

// ── Core functions ───────────────────────────────────────────────────

function prepareMessages(messages) {
  const nonSystem = messages.filter(m => m.role !== 'system');
  const recent = nonSystem.slice(-MAX_MESSAGES_FOR_EXTRACTION);
  return recent.map(m => {
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role;
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const content = raw.trim();
    const truncated = content.length > MAX_CONTENT_PER_MESSAGE
      ? content.slice(0, MAX_CONTENT_PER_MESSAGE) + '...'
      : content;
    return `[${role}]: ${truncated}`;
  }).join('\n\n');
}

function parsePacket(raw) {
  const text = String(raw || '');
  // Strip markdown fences if present
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  // Extract JSON object
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.goal && !parsed.progress) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extract a structured state packet from session messages using an LLM.
 * @param {Array} messages - Session messages array ({role, content})
 * @param {object} [options] - { provider?, timeout? }
 * @returns {Promise<object|null>} Parsed state packet or null on failure
 */
export async function extractStatePacket(messages, options = {}) {
  const nonSystem = (messages || []).filter(m => m.role !== 'system');
  if (nonSystem.length < 3) return null;

  const prepared = prepareMessages(messages);
  const prompt = EXTRACTION_PROMPT.replace('{{MESSAGES}}', prepared);
  const presetId = options.preset || 'sonnet-mid';
  const timeout = options.timeout || 60000;

  try {
    const raw = await callLLM(prompt, presetId, { mode: 'maintenance', timeout });
    return parsePacket(raw);
  } catch (e) {
    process.stderr.write(`[state-packet] extraction failed: ${e.message}\n`);
    return null;
  }
}

// ── Formatting for session injection ─────────────────────────────────

/**
 * Format a state packet as markdown for session injection.
 * @param {object} packet - State packet from extractStatePacket()
 * @returns {string} Formatted text block
 */
export function formatStatePacket(packet) {
  if (!packet) return '';

  const lines = ['## Session State (auto-extracted)'];

  if (packet.goal) {
    lines.push(`**Goal**: ${packet.goal}`);
  }

  if (packet.constraints?.length) {
    lines.push(`**Constraints**: ${packet.constraints.join('; ')}`);
  }

  if (packet.progress) {
    const parts = [];
    if (packet.progress.done?.length) parts.push(`Done: ${packet.progress.done.join(', ')}`);
    if (packet.progress.inProgress?.length) parts.push(`In progress: ${packet.progress.inProgress.join(', ')}`);
    if (packet.progress.blocked?.length) parts.push(`Blocked: ${packet.progress.blocked.join(', ')}`);
    if (parts.length) lines.push(`**Progress**: ${parts.join(' | ')}`);
  }

  if (packet.keyDecisions?.length) {
    lines.push(`**Key decisions**: ${packet.keyDecisions.join('; ')}`);
  }

  if (packet.relevantFiles?.length) {
    lines.push(`**Relevant files**: ${packet.relevantFiles.join(', ')}`);
  }

  if (packet.nextSteps?.length) {
    lines.push(`**Next steps**: ${packet.nextSteps.join('; ')}`);
  }

  if (packet.criticalContext?.length) {
    lines.push(`**Critical context**: ${packet.criticalContext.join('; ')}`);
  }

  return lines.join('\n');
}

// ── Persistence ──────────────────────────────────────────────────────

function ensurePacketDir() {
  if (!existsSync(PACKET_DIR)) mkdirSync(PACKET_DIR, { recursive: true });
}

function packetPath(scopeKey) {
  const safe = String(scopeKey).replace(/[<>:"/\\|?*]/g, '_');
  return join(PACKET_DIR, `${safe}.json`);
}

/**
 * Save a state packet to disk, keyed by scope.
 * @param {string} scopeKey - Session scope key
 * @param {object} packet - State packet
 */
export function saveStatePacket(scopeKey, packet) {
  if (!scopeKey || !packet) return;
  ensurePacketDir();
  const data = { packet, savedAt: Date.now() };
  const target = packetPath(scopeKey);
  const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Load a state packet from disk. Returns null if expired or missing.
 * @param {string} scopeKey - Session scope key
 * @returns {object|null} State packet or null
 */
export function loadStatePacket(scopeKey) {
  if (!scopeKey) return null;
  const p = packetPath(scopeKey);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    if (Date.now() - (data.savedAt || 0) > PACKET_TTL_MS) return null;
    return data.packet || null;
  } catch {
    return null;
  }
}

// ── Session injection ────────────────────────────────────────────────

/**
 * Inject a state packet into session messages as context.
 * Inserts after the system message(s), before user messages.
 * @param {Array} messages - Session message array (mutated in place)
 * @param {object} packet - State packet
 * @returns {boolean} True if injection occurred
 */
export function injectStatePacket(messages, packet) {
  if (!packet || !messages) return false;
  const formatted = formatStatePacket(packet);
  if (!formatted) return false;

  // Skip if state packet was already injected
  const marker = '## Session State (auto-extracted)';
  if (messages.some(m => typeof m.content === 'string' && m.content.includes(marker))) {
    return false;
  }

  // Find insertion point: after last system message
  let insertIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') insertIdx = i + 1;
  }

  messages.splice(insertIdx, 0,
    { role: 'user', content: formatted },
    { role: 'assistant', content: 'Understood. I have the prior session context.' },
  );
  return true;
}

/**
 * Extract state from a session and save for the next session with the same scope.
 * Call this before closing or when a session reaches context limits.
 * @param {object} session - Session object from store
 * @param {object} [options] - { provider?, timeout? }
 * @returns {Promise<object|null>} The extracted packet, or null
 */
export async function extractAndSave(session, options = {}) {
  if (!session?.messages?.length) return null;
  const packet = await extractStatePacket(session.messages, options);
  if (packet && session.scopeKey) {
    saveStatePacket(session.scopeKey, packet);
  }
  return packet;
}

/**
 * Attempt to load and inject a saved state packet into a session.
 * Intended for use during session creation or resume.
 * @param {object} session - Session object (messages array is mutated)
 * @returns {boolean} True if a packet was injected
 */
export function restoreStatePacket(session) {
  if (!session?.scopeKey) return false;
  const packet = loadStatePacket(session.scopeKey);
  if (!packet) return false;
  return injectStatePacket(session.messages, packet);
}
