/**
 * cli-runner.mjs — Isolated CLI runner for Claude.
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
