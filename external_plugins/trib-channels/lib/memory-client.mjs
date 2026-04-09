/**
 * memory-client.mjs — HTTP client for memory-service.
 *
 * Replaces direct memoryStore calls in server.ts with HTTP requests
 * to the memory-service process (runs on 127.0.0.1:3350-3357).
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT_FILE = path.join(os.tmpdir(), 'trib-memory', 'memory-port')

function getMemoryPort() {
  try {
    return Number(fs.readFileSync(PORT_FILE, 'utf8').trim()) || 3350
  } catch {
    return 3350
  }
}

/**
 * Send an HTTP request to the memory service.
 * @param {string} method - GET or POST
 * @param {string} endpoint - e.g. '/episode'
 * @param {object|null} body - JSON body for POST
 * @returns {Promise<object>}
 */
function memoryFetch(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const port = getMemoryPort()
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: 10_000,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve({ raw: data })
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('memory-service timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

const BUFFER_DIR = path.join(os.tmpdir(), 'trib-channels', 'memory-buffer')

/**
 * Append an episode to the memory store.
 * On first failure: wait 2s, retry once.
 * On retry failure: buffer to a local JSON file and return { ok: false, buffered: true, path }.
 * @param {object} data - Episode fields (ts, backend, channelId, userId, userName, sessionId, role, kind, content, sourceRef)
 * @returns {Promise<{ok: boolean, id?: number, buffered?: boolean, path?: string}>}
 */
export async function appendEpisode(data) {
  try {
    return await memoryFetch('POST', '/episode', data)
  } catch (e) {
    process.stderr.write(`[memory-client] appendEpisode failed: ${e.message}\n`)

    // Wait 2 seconds then retry once
    await new Promise(r => setTimeout(r, 2000))
    try {
      process.stderr.write(`[memory-client] appendEpisode retrying...\n`)
      return await memoryFetch('POST', '/episode', data)
    } catch (retryErr) {
      process.stderr.write(`[memory-client] appendEpisode retry failed: ${retryErr.message}\n`)

      // Buffer to local JSON file
      try {
        fs.mkdirSync(BUFFER_DIR, { recursive: true })
        const random = Math.random().toString(36).slice(2, 10)
        const bufferPath = path.join(BUFFER_DIR, `episode-${Date.now()}-${random}.json`)
        fs.writeFileSync(bufferPath, JSON.stringify(data, null, 2))
        process.stderr.write(`[memory-client] Episode buffered to ${bufferPath}\n`)
        return { ok: false, buffered: true, path: bufferPath }
      } catch (bufErr) {
        process.stderr.write(`[memory-client] Failed to buffer episode: ${bufErr.message}\n`)
        return { ok: false }
      }
    }
  }
}


function cleanupStaleBufferFiles(maxAgeDays = 7) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  let cleaned = 0
  try {
    const files = fs.readdirSync(BUFFER_DIR).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(BUFFER_DIR, file)
      try {
        const stats = fs.statSync(filePath)
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath)
          cleaned++
        }
      } catch (e) {
        process.stderr.write(`[memory-client] cleanupStaleBufferFiles error for ${file}: ${e.message}\n`)
      }
    }
  } catch { /* buffer dir does not exist */ }
  return cleaned
}

/**
 * Flush all buffered episodes that failed to send previously.
 * Reads each JSON file from the buffer directory, POSTs it via memoryFetch,
 * and deletes successfully flushed files. Cleans up stale files (>7 days).
 * @returns {Promise<{flushed: number, failed: number}>}
 */
export async function flushBufferedEpisodes() {
  let flushed = 0
  let failed = 0
  let files
  try {
    files = fs.readdirSync(BUFFER_DIR).filter(f => f.endsWith('.json'))
  } catch {
    // Buffer directory does not exist or is unreadable — nothing to flush
    return { flushed, failed }
  }

  for (const file of files) {
    const filePath = path.join(BUFFER_DIR, file)
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      await memoryFetch('POST', '/episode', data)
      fs.unlinkSync(filePath)
      flushed++
    } catch (e) {
      process.stderr.write(`[memory-client] flushBufferedEpisodes failed for ${file}: ${e.message}\n`)
      failed++
    }
  }
  cleanupStaleBufferFiles()
  return { flushed, failed }
}

/**
 * Ingest a transcript file into the memory store.
 * @param {string} filePath - Absolute path to the transcript JSONL file
 * @returns {Promise<{ok: boolean}>}
 */
export async function ingestTranscript(filePath) {
  try {
    return await memoryFetch('POST', '/ingest-transcript', { filePath })
  } catch (e) {
    process.stderr.write(`[memory-client] ingestTranscript failed: ${e.message}\n`)
    return { ok: false }
  }
}

/**
 * Check if the memory service is healthy.
 * @returns {Promise<boolean>}
 */
export async function isHealthy() {
  try {
    const result = await memoryFetch('GET', '/health')
    return result.status === 'ok'
  } catch {
    return false
  }
}
