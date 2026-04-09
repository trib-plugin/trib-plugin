/**
 * Webhook HTTP server — receives external webhook POST requests
 * and routes them to the event pipeline.
 */

import * as http from 'http'
import * as crypto from 'crypto'
import { join, dirname } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import type { WebhookConfig, ChannelsConfig } from '../backends/types.js'
import type { EventPipeline } from './event-pipeline.js'
import { DATA_DIR, PLUGIN_ROOT } from './config.js'
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from 'fs'

const WEBHOOKS_DIR = join(DATA_DIR, 'webhooks')

const DELEGATE_CLI = join(PLUGIN_ROOT, 'scripts', 'delegate-cli.mjs')

const WEBHOOK_LOG = join(DATA_DIR, 'webhook.log')
function logWebhook(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { process.stderr.write(`trib-plugin webhook: ${msg}\n`) } catch { /* EPIPE */ }
  try { appendFileSync(WEBHOOK_LOG, line) } catch { /* best effort */ }
}

// ── Signature verification ────────────────────────────────────────────

/** Header names that carry HMAC signatures, mapped per service. */
const SIGNATURE_HEADERS: Record<string, { header: string; prefix: string }> = {
  github:  { header: 'x-hub-signature-256', prefix: 'sha256=' },
  sentry:  { header: 'sentry-hook-signature', prefix: '' },
  stripe:  { header: 'stripe-signature', prefix: '' },
  generic: { header: 'x-signature-256', prefix: 'sha256=' },
}

/**
 * Extract the raw signature value from request headers.
 * Tries service-specific header first, then falls back to common ones.
 */
function extractSignature(headers: Record<string, string>, parser?: string): string | null {
  // Try service-specific header first
  if (parser) {
    const mapping = SIGNATURE_HEADERS[parser]
    if (mapping) {
      const raw = headers[mapping.header]
      if (raw) return mapping.prefix ? raw.replace(mapping.prefix, '') : raw
    }
  }
  // Fallback: try all known headers
  for (const mapping of Object.values(SIGNATURE_HEADERS)) {
    const raw = headers[mapping.header]
    if (raw) return mapping.prefix ? raw.replace(mapping.prefix, '') : raw
  }
  return null
}

/**
 * Verify HMAC-SHA256 signature of the raw body against the shared secret.
 * For Stripe, the signature format is "t=...,v1=..." — extract v1 value.
 */
function verifySignature(secret: string, rawBody: string, signatureValue: string, parser?: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  // Stripe uses "t=timestamp,v1=signature" format
  if (parser === 'stripe') {
    const match = signatureValue.match(/v1=([a-f0-9]+)/)
    if (!match) return false
    return crypto.timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(expected, 'hex'))
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureValue, 'hex'),
      Buffer.from(expected, 'hex'),
    )
  } catch {
    return false
  }
}

// ── WebhookServer ─────────────────────────────────────────────────────

const NGROK_PID_FILE = join(DATA_DIR, 'ngrok.pid')

export class WebhookServer {
  private config: WebhookConfig
  private server: http.Server | null = null
  private eventPipeline: EventPipeline | null = null
  private boundPort: number = 0
  private noSecretWarned = false
  private ngrokProcess: ReturnType<typeof spawn> | null = null
  private ngrokStarting = false

  constructor(config: WebhookConfig, _channelsConfig: ChannelsConfig | null) {
    this.config = config
  }

  setEventPipeline(pipeline: EventPipeline): void { this.eventPipeline = pipeline }

  // ── HTTP server ───────────────────────────────────────────────────

  start(): void {
    if (this.server) return

    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
        return
      }

      if (req.method === 'POST' && req.url?.startsWith('/webhook/')) {
        const name = req.url.slice('/webhook/'.length).split('?')[0]
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk })
        req.on('end', () => {
          try {
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === 'string') headers[k.toLowerCase()] = v
            }

            // Signature verification
            const secret = this.config.secret
            if (secret) {
              const endpoint = this.config.endpoints?.[name]
              const signature = extractSignature(headers, endpoint?.parser)
              if (!signature) {
                logWebhook(`${name}: rejected — no signature header found`)
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'missing signature' }))
                return
              }
              if (!verifySignature(secret, body, signature, endpoint?.parser)) {
                logWebhook(`${name}: rejected — signature mismatch`)
                res.writeHead(403, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'invalid signature' }))
                return
              }
            } else {
              if (!this.noSecretWarned) {
                this.noSecretWarned = true
                logWebhook(`warning — no webhook secret configured, skipping signature verification`)
              }
            }

            const parsed = body ? JSON.parse(body) : {}
            this.handleWebhook(name, parsed, headers, res)
          } catch (err) {
            logWebhook(`JSON parse error for ${name}: ${err}`)
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid JSON' }))
          }
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    })

    const basePort = this.config.port || 3333
    const maxPort = basePort + 7
    let currentPort = basePort

    const tryListen = () => {
      this.server!.listen(currentPort, () => {
        this.boundPort = currentPort
        logWebhook(`listening on port ${currentPort}`)
      })
    }

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && currentPort < maxPort) {
        logWebhook(`port ${currentPort} already in use, trying ${currentPort + 1}`)
        currentPort++
        tryListen()
      } else if (err.code === 'EADDRINUSE') {
        logWebhook(`all ports ${basePort}-${maxPort} in use — webhook server disabled`)
        this.server = null
      }
    })

    tryListen()

    // Auto-start ngrok tunnel if authtoken + domain configured
    this.startNgrok()
  }

  /** Kill any previous ngrok process left behind from a crashed session */
  private killPreviousNgrok(): void {
    try {
      const pidContent = readFileSync(NGROK_PID_FILE, 'utf8').trim()
      const pid = parseInt(pidContent)
      if (pid > 0) {
        // Check if PID file is stale (>1h) — delete without killing
        try {
          const age = Date.now() - statSync(NGROK_PID_FILE).mtimeMs
          if (age > 60 * 60 * 1000) {
            logWebhook(`ngrok PID file stale (${Math.round(age / 60000)}m old), removing without kill`)
            try { unlinkSync(NGROK_PID_FILE) } catch {}
            return
          }
        } catch { /* stat failed, proceed with kill attempt */ }

        // Verify PID is alive before killing
        try {
          process.kill(pid, 0)
          process.kill(pid)
          logWebhook(`killed previous ngrok (PID ${pid})`)
        } catch { /* already dead */ }
      }
    } catch { /* no PID file or unreadable */ }
    try { unlinkSync(NGROK_PID_FILE) } catch {}
  }

  private startNgrok(): void {
    if (this.ngrokProcess || this.ngrokStarting) return
    const authtoken = (this.config as any).authtoken
    const domain = this.config.ngrokDomain || (this.config as any).domain
    if (!authtoken || !domain) return
    this.ngrokStarting = true

    // Kill any orphaned ngrok from a previous session
    this.killPreviousNgrok()

    // Resolve ngrok binary path (cross-platform)
    let ngrokBin = 'ngrok'
    const whichCmd = process.platform === 'win32' ? 'where' : 'which'
    try {
      const r = spawnSync(whichCmd, ['ngrok'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const resolved = (r.stdout || '').trim().split(/\r?\n/)[0]
      if (r.status === 0 && resolved) ngrokBin = resolved
    } catch { /* use default */ }

    // Set authtoken (array args — no injection risk)
    spawnSync(ngrokBin, ['config', 'add-authtoken', authtoken], { stdio: 'ignore', timeout: 10000, windowsHide: true })

    // Wait for server to bind, then start tunnel (max 15s)
    let attempts = 0
    const waitAndStart = () => {
      if (!this.boundPort) {
        if (++attempts > 30) { logWebhook('ngrok: gave up waiting for port'); this.ngrokStarting = false; return }
        setTimeout(waitAndStart, 500)
        return
      }
      try {
        this.ngrokProcess = spawn(ngrokBin, ['http', String(this.boundPort), '--url=' + domain], {
          stdio: 'ignore', windowsHide: true,
        })
        this.ngrokProcess.unref()
        // Save PID for orphan cleanup on next startup
        if (this.ngrokProcess.pid) {
          try { writeFileSync(NGROK_PID_FILE, String(this.ngrokProcess.pid)) } catch {}
        }
        this.ngrokProcess.on('exit', () => {
          this.ngrokProcess = null
          this.ngrokStarting = false
          try { unlinkSync(NGROK_PID_FILE) } catch {}
        })
        this.ngrokProcess.on('error', () => {
          this.ngrokProcess = null
          this.ngrokStarting = false
          try { unlinkSync(NGROK_PID_FILE) } catch {}
        })
        logWebhook(`ngrok tunnel started: ${domain} → localhost:${this.boundPort} (PID ${this.ngrokProcess.pid})`)
      } catch (e) {
        logWebhook(`ngrok start failed: ${e}`)
      }
      this.ngrokStarting = false
    }
    setTimeout(waitAndStart, 1000)
  }

  stop(): void {
    if (this.ngrokProcess) {
      try { this.ngrokProcess.kill() } catch { /* already dead */ }
      this.ngrokProcess = null
      try { unlinkSync(NGROK_PID_FILE) } catch {}
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    logWebhook('stopped')
  }

  reloadConfig(
    config: WebhookConfig,
    _channelsConfig: ChannelsConfig | null,
    options: { autoStart?: boolean } = {},
  ): void {
    this.stop()
    this.config = config
    if (options.autoStart !== false && config.enabled) this.start()
  }

  // ── Delegate analysis via trib-agent ────────────────────────────────

  private delegateAnalysis(
    name: string,
    prompt: string,
    model: string | null,
    channel: string,
    exec: 'interactive' | 'non-interactive',
  ): void {
    const args: string[] = []
    if (model) args.push('--preset', model)
    args.push(prompt)
    const child = spawn('node', [DELEGATE_CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    if (child.stdout) child.stdout.on('data', (d: Buffer) => { stdout += d })
    if (child.stderr) child.stderr.on('data', (d: Buffer) => { stderr += d })

    child.on('close', (code: number | null) => {
      let result = ''
      try {
        const parsed = JSON.parse(stdout)
        result = parsed.content || stdout.trim()
      } catch {
        result = stdout.trim()
      }

      if (!result) {
        logWebhook(`${name}: delegate returned empty (code=${code}, stderr=${stderr.slice(0, 200)})`)
        return
      }

      logWebhook(`${name}: delegate done (${model}, ${result.length} chars)`)

      // Route result based on exec mode
      if (this.eventPipeline) {
        this.eventPipeline.enqueueDirect(name, result, channel, exec)
      }
    })

    child.on('error', (err: Error) => {
      logWebhook(`${name}: delegate spawn error: ${err.message}`)
    })
  }

  // ── Webhook handler ───────────────────────────────────────────────

  private handleWebhook(
    name: string,
    body: any,
    headers: Record<string, string>,
    res: http.ServerResponse,
  ): void {
    // Folder-based webhook: webhooks/{name}/instructions.md
    const folderPath = join(WEBHOOKS_DIR, name)
    const instructionsPath = join(folderPath, 'instructions.md')
    if (existsSync(instructionsPath)) {
      try {
        const instructions = readFileSync(instructionsPath, 'utf8').trim()

        // Optional config: channel, exec, model, analyze
        let channel = 'main'
        let exec: 'interactive' | 'non-interactive' = 'interactive'
        let model: string | null = null
        let analyze = false
        const configPath = join(folderPath, 'config.json')
        if (existsSync(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
            if (cfg.channel) channel = cfg.channel
            if (cfg.exec) exec = cfg.exec
            if (cfg.model) model = cfg.model
            if (cfg.analyze === true) analyze = true
          } catch { /* use defaults */ }
        }

        const payload = JSON.stringify(body, null, 2)
        const headersSummary = Object.entries(headers)
          .filter(([k]) => k.startsWith('x-') || k === 'content-type')
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')

        const prompt = `${instructions}\n\n--- Webhook Headers ---\n${headersSummary}\n\n--- Webhook Payload ---\n${payload}`

        // Analyze enabled → delegate-cli for background analysis
        if (analyze && existsSync(DELEGATE_CLI)) {
          this.delegateAnalysis(name, prompt, model, channel, exec)
          logWebhook(`${name}: folder-based → delegate (${model})`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'accepted', handler: 'delegate' }))
          return
        }

        // No model → raw inject
        if (this.eventPipeline) {
          this.eventPipeline.enqueueDirect(name, prompt, channel, exec)
          logWebhook(`${name}: folder-based → enqueued (${exec})`)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'accepted', handler: 'folder' }))
        return
      } catch (err) {
        logWebhook(`${name}: folder handler error: ${err}`)
      }
    }

    // Fallback: event pipeline rule-based routing
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      logWebhook(`${name}: routed to event pipeline`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'accepted' }))
      return
    }

    logWebhook(`unknown endpoint: ${name}`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown endpoint' }))
  }

  /** Get the webhook URL for an endpoint name */
  getUrl(name: string): string {
    if (this.config.ngrokDomain) {
      return `https://${this.config.ngrokDomain}/webhook/${name}`
    }
    return `http://localhost:${this.boundPort || this.config.port}/webhook/${name}`
  }
}
