import fs from 'fs'
import path from 'path'
import { DATA_DIR, PLUGIN_ROOT } from './config.mjs'

const DEFAULT_FILE = path.join(PLUGIN_ROOT, 'settings.default.md')
const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md')

function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return ''
  }
}

export function loadSettings() {
  const today = new Date().toISOString().split('T')[0]
  const datePrefix = `Current date: ${today}.\nYour training data may be outdated. For any information that could have changed since your knowledge cutoff — versions, pricing, APIs, status, recent events — always verify via search before answering.`

  return [datePrefix, tryRead(DEFAULT_FILE), tryRead(LOCAL_FILE)]
    .filter(Boolean)
    .join('\n\n')
}
