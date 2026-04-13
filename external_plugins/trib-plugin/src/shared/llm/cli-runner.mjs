/**
 * cli-runner.mjs — Isolated CLI runners for Claude, Codex, Gemini.
 * Each runner is self-contained. No cross-provider dependencies.
 */
import { spawn } from 'child_process'

function spawnPromise(command, args, stdin, options = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: { ...process.env },
      windowsHide: true,
      shell: isWin,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, options.timeout || 180000)

    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`${command} timed out after ${options.timeout || 180000}ms`))
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
