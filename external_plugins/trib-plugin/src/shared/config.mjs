/**
 * Unified config reader/writer.
 * Single file: trib-config.json with sections: channels, agent, memory, search.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin')

const CONFIG_PATH = join(DATA_DIR, 'trib-config.json')

// Legacy file paths for one-time migration
const LEGACY_FILES = {
  channels: 'config.json',
  agent: 'agent-config.json',
  memory: 'memory-config.json',
  search: 'search-config.json',
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return null }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

function readAll() {
  const existing = readJsonFile(CONFIG_PATH)
  if (existing) return existing

  // First run: migrate from legacy files
  const merged = {}
  for (const [section, filename] of Object.entries(LEGACY_FILES)) {
    const legacy = readJsonFile(join(DATA_DIR, filename))
    if (legacy) merged[section] = legacy
  }
  if (Object.keys(merged).length > 0) {
    writeJsonFile(CONFIG_PATH, merged)
  }
  return merged
}

function writeAll(data) {
  writeJsonFile(CONFIG_PATH, data)
}

export function readSection(section) {
  return readAll()[section] || {}
}

export function writeSection(section, data) {
  const all = readAll()
  all[section] = data
  writeAll(all)
}

export function updateSection(section, updater) {
  const all = readAll()
  all[section] = updater(all[section] || {})
  writeAll(all)
}

export { DATA_DIR, CONFIG_PATH }
