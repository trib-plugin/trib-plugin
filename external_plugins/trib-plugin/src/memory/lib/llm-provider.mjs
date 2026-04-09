/**
 * llm-provider.mjs — Unified LLM provider abstraction layer.
 * Delegates to trib-agent's delegate-cli for model calls.
 * Falls back to direct provider calls if delegate-cli is unavailable.
 */

import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const DELEGATE_CLI = join(
  homedir(), '.claude', 'plugins', 'marketplaces', 'trib-plugin',
  'external_plugins', 'trib-plugin', 'src', 'agent', 'orchestrator', 'cli.js',
)

// Reverse map: connection format → trib-agent provider name
const CONNECTION_TO_PROVIDER = {
  codex: 'openai-oauth',
  cli: 'native',
  ollama: 'ollama',
  api: 'openai',  // default, overridden by apiProvider field
}

async function execBuffered(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout || 60000,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  return {
    stdout: String(stdout ?? '').trim(),
    stderr: String(stderr ?? '').trim(),
    code: 0,
  }
}

async function execWithInput(command, args, stdin, options = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const safeArgs = isWin ? args.map(a => /\s/.test(a) ? `"${a}"` : a) : args
    const child = spawn(command, safeArgs, {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd ?? process.cwd(),
      shell: isWin,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeoutMs = options.timeout || 120000
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
        return
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
        return
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      })
    })

    child.stdin.write(String(stdin ?? ''))
    child.stdin.end()
  })
}

/**
 * @param {string} prompt — Prompt to send to LLM
 * @param {object} provider — { connection, model, effort?, fast?, baseUrl? }
 * @param {object} options — { timeout?, cwd?, retries? }
 * @returns {Promise<string>} — LLM response text
 */
export async function callLLM(prompt, provider, options = {}) {
  // Try delegate-cli first (unified model management via trib-agent)
  if (existsSync(DELEGATE_CLI) && provider.connection !== 'cli') {
    try {
      return await callDelegateCli(prompt, provider, options)
    } catch (e) {
      process.stderr.write(`[llm-provider] delegate-cli failed, falling back to direct: ${e.message}\n`)
    }
  }

  // Fallback: direct provider calls
  const maxRetries = Math.max(0, Number(options.retries ?? 1))
  const baseTimeout = options.timeout || 180000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptTimeout = baseTimeout + (attempt * 60000)
    const attemptOptions = { ...options, timeout: attemptTimeout }

    try {
      switch (provider.connection) {
        case 'codex':
          return await callCodex(prompt, provider, attemptOptions)
        case 'cli':
          return await callClaude(prompt, provider, attemptOptions)
        case 'ollama':
          return await callOllama(prompt, provider, attemptOptions)
        case 'api':
          return await callAPI(prompt, provider, attemptOptions)
        default:
          throw new Error(`Unknown provider connection: ${provider.connection}`)
      }
    } catch (e) {
      const isTimeout = /timed?\s*out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up/i.test(e.message)
      if (!isTimeout || attempt >= maxRetries) throw e
      process.stderr.write(`[llm-provider] timeout on attempt ${attempt + 1}, retrying...\n`)
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
}

async function callDelegateCli(prompt, provider, options = {}) {
  const agentProvider = provider.apiProvider || CONNECTION_TO_PROVIDER[provider.connection] || provider.connection
  const args = [DELEGATE_CLI, 'delegate', '--provider', agentProvider, '--model', provider.model || 'gpt-5.4-mini']
  args.push(prompt)

  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: options.timeout || 180000,
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`delegate-cli exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed.content || stdout.trim())
      } catch {
        resolve(stdout.trim())
      }
    })

    child.on('error', reject)
  })
}

async function callCodex(prompt, provider, options) {
  const args = ['exec', '--json', '--model', provider.model || 'gpt-5.4']
  if (provider.effort) args.push('-c', `model_reasoning_effort=${provider.effort}`)
  if (provider.fast) args.push('-c', 'service_tier=fast')
  args.push('--skip-git-repo-check')

  const { stdout } = await execWithInput('codex', args, prompt, { ...options, provider })

  // JSON streaming parse — extract LAST agent_message text
  const lines = stdout.split('\n').filter(l => l.trim())
  let lastText = ''
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        lastText = obj.item.text
      }
    } catch { /* skip non-JSON lines */ }
  }
  return lastText
}

async function callClaude(prompt, provider, options) {
  const args = [
    '-p',
    '--model', provider.model || 'sonnet',
    '--output-format', 'json',
    '--system-prompt', 'You are a memory extraction system.',
    '--no-session-persistence',
  ]
  if (provider.effort) args.push('--effort', provider.effort)

  const runClaudeOnce = async () => {
    const { stdout } = await execWithInput('claude', args, prompt, { ...options, provider })
    try {
      const parsed = JSON.parse(stdout)
      if (parsed?.is_error) {
        throw new Error(String(parsed?.result ?? 'claude provider returned an error'))
      }
      return String(parsed?.result ?? '').trim()
    } catch {
      return stdout.trim()
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runClaudeOnce()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryable = /Not logged in/i.test(message)
      if (!retryable || attempt >= 2) throw error
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

async function callOllama(prompt, provider, options) {
  const baseUrl = provider.baseUrl || 'http://localhost:11434'
  const payload = JSON.stringify({
    model: provider.model || 'qwen3.5:9b',
    prompt,
    stream: false,
    options: { num_ctx: 4096, temperature: 0 },
  })
  const { stdout } = await execFileAsync('curl', [
    '-s',
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', payload,
    `${baseUrl}/api/generate`,
  ], {
    timeout: options.timeout || 120000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const data = JSON.parse(stdout || '{}')
  return data.response || ''
}

async function callAPI(prompt, provider, options) {
  const apiKey = provider.apiKey || ''
  if (!apiKey) throw new Error('API key required for api provider')
  const model = provider.model || 'gpt-5.4-mini'
  const isAnthropic = /claude|anthropic/i.test(model) || provider.apiProvider === 'anthropic'

  if (isAnthropic) {
    const payload = JSON.stringify({
      model,
      max_tokens: 8192,
      system: 'You are a memory extraction system.',
      messages: [{ role: 'user', content: prompt }],
    })
    const { stdout } = await execFileAsync('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `x-api-key: ${apiKey}`,
      '-H', 'anthropic-version: 2023-06-01',
      '-d', payload,
      'https://api.anthropic.com/v1/messages',
    ], { timeout: options.timeout || 180000, maxBuffer: 10 * 1024 * 1024 })
    const data = JSON.parse(stdout || '{}')
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || ''
  }

  // OpenAI-compatible API
  const baseUrl = provider.baseUrl || 'https://api.openai.com/v1'
  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a memory extraction system.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  })
  const { stdout } = await execFileAsync('curl', [
    '-s', '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', payload,
    `${baseUrl}/chat/completions`,
  ], { timeout: options.timeout || 180000, maxBuffer: 10 * 1024 * 1024 })
  const data = JSON.parse(stdout || '{}')
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return data.choices?.[0]?.message?.content || ''
}
