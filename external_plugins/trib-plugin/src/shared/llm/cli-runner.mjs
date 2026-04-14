/**
 * cli-runner.mjs — Isolated CLI runners for Claude, Codex, Gemini.
 * Each runner is self-contained. No cross-provider dependencies.
 */
import { spawn, execFileSync } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'

// ── PID tracking for orphan cleanup ─────────────────────────────────
const PID_DIR = path.join(os.tmpdir(), 'trib-bridge')
const PID_FILE = path.join(PID_DIR, 'bridge-pids.json')

function trackPid(pid) {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true })
    let pids = []
    try { pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) } catch {}
    if (!pids.includes(pid)) pids.push(pid)
    fs.writeFileSync(PID_FILE, JSON.stringify(pids))
  } catch {}
}

function untrackPid(pid) {
  try {
    let pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
    pids = pids.filter(p => p !== pid)
    fs.writeFileSync(PID_FILE, JSON.stringify(pids))
  } catch {}
}

export function cleanupOrphanedPids() {
  let killed = 0
  try {
    const pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
    for (const pid of pids) {
      try {
        process.kill(pid, 0) // check if alive
        process.kill(pid, 'SIGTERM')
        process.stderr.write(`[bridge-cleanup] killed orphaned PID ${pid}\n`)
        killed++
      } catch {}
    }
    fs.writeFileSync(PID_FILE, JSON.stringify([]))
  } catch {}
  return killed
}

// ── Runner concurrency limiter ─────────────────────────────────────
const MAX_CONCURRENT_RUNNERS = 3
let _activeRunners = 0
const _runnerQueue = []

function acquireRunner() {
  return new Promise(resolve => {
    if (_activeRunners < MAX_CONCURRENT_RUNNERS) {
      _activeRunners++
      resolve()
    } else {
      _runnerQueue.push(resolve)
    }
  })
}

function releaseRunner() {
  _activeRunners--
  if (_runnerQueue.length > 0) {
    _activeRunners++
    _runnerQueue.shift()()
  }
}

function spawnPromise(command, args, stdin, options = {}) {
  return new Promise(async (resolve, reject) => {
    await acquireRunner()
    const isWin = process.platform === 'win32'
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: { ...process.env },
      windowsHide: true,
      shell: isWin,
    })

    if (child.pid) trackPid(child.pid)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let released = false
    const doRelease = () => { if (!released) { released = true; releaseRunner() } }
    const MIN_TIMEOUT = 10000   // 10s minimum
    const MAX_TIMEOUT = 600000  // 10m maximum
    const effectiveTimeout = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, options.timeout || 180000))

    let escalationTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      // Escalate: if still alive after 5s, force kill
      escalationTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
          } else {
            child.kill('SIGKILL')
          }
        } catch {}
      }, 5000)
    }, effectiveTimeout)

    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => { clearTimeout(timer); if (escalationTimer) clearTimeout(escalationTimer); doRelease(); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (escalationTimer) clearTimeout(escalationTimer)
      if (child.pid) untrackPid(child.pid)
      doRelease()
      if (timedOut) return reject(new Error(`${command} timed out after ${effectiveTimeout}ms`))
      if (code !== 0) {
        return reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })

    if (stdin != null) { child.stdin.write(String(stdin)); child.stdin.end() }
    else { child.stdin.end() }
  })
}

/**
 * Run Claude Code CLI.
 * maintenance mode: --setting-sources "" --tools "" (complete context isolation, 0 token overhead)
 * active mode: normal execution with full context
 */
export async function runClaude(prompt, options = {}) {
  const { model = 'sonnet', mode = 'maintenance', timeout = 180000, systemPrompt, effort } = options

  const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence']

  if (mode === 'maintenance') {
    args.push('--setting-sources=', '--tools=')
  } else if (mode === 'light') {
    args.push('--setting-sources=')  // strip settings/CLAUDE.md, keep tools
  }
  if (systemPrompt) args.push('--system-prompt', systemPrompt)
  if (effort) args.push('--effort', effort)

  const { stdout } = await spawnPromise('claude', args, prompt, { timeout })

  try {
    const parsed = JSON.parse(stdout)
    if (parsed?.is_error) throw new Error(parsed?.result || 'claude returned error')
    return {
      text: String(parsed?.result ?? '').trim(),
      usage: { costUsd: parsed?.total_cost_usd || 0 },
    }
  } catch (e) {
    if (e.message.includes('claude returned error')) throw e
    return { text: stdout.trim(), usage: null }
  }
}

/**
 * Run Codex CLI (OpenAI OAuth).
 * maintenance mode: --skip-git-repo-check --full-auto --ephemeral
 * active mode: --skip-git-repo-check only
 */
export async function runCodex(prompt, options = {}) {
  const { model = 'gpt-5.4-mini', mode = 'maintenance', timeout = 180000, effort, fast } = options

  const args = ['exec', '--json', '--model', model, '--skip-git-repo-check']

  if (mode === 'maintenance') {
    args.push('--full-auto', '--ephemeral')
  }
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
  if (fast) args.push('-c', 'service_tier=fast')

  const { stdout } = await spawnPromise('codex', args, prompt, { timeout })

  const lines = stdout.split('\n').filter(l => l.trim())
  let lastText = ''
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        lastText = obj.item.text
      }
    } catch {}
  }
  if (!lastText) throw new Error('Codex returned no agent_message')
  return { text: lastText, usage: null }
}

/**
 * Run Gemini CLI.
 * Note: Gemini CLI isolation flags TBD — auth not configured yet.
 */
export async function runGemini(prompt, options = {}) {
  const { model = 'gemini-2.5-flash', timeout = 180000 } = options

  const args = ['-p', prompt, '-o', 'json', '-m', model]

  const { stdout } = await spawnPromise('gemini', args, null, { timeout })

  try {
    const parsed = JSON.parse(stdout)
    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error))
    const text = parsed.response || parsed.text || parsed.result || ''
    if (!text) throw new Error('Gemini returned empty response')
    return { text, usage: null }
  } catch (e) {
    if (e.message && !e.message.includes('Unexpected')) throw e
    if (!stdout.trim()) throw new Error('Gemini returned empty output')
    return { text: stdout.trim(), usage: null }
  }
}
