/**
 * Webhook HTTP server — receives external webhook POST requests
 * and routes them to the event pipeline.
 */

import * as http from 'http'
import * as crypto from 'crypto'
import { join } from 'path'
import type { WebhookConfig, ChannelsConfig } from '../backends/types.js'
import type { EventPipeline } from './event-pipeline.js'
import { DATA_DIR } from './config.js'
import { appendFileSync } from 'fs'

const WEBHOOK_LOG = join(DATA_DIR, 'webhook.log')
function logWebhook(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { process.stderr.write(`trib-channels webhook: ${msg}\n`) } catch { /* EPIPE */ }
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

export class WebhookServer {
  private config: WebhookConfig
  private server: http.Server | null = null
  private eventPipeline: EventPipeline | null = null
  private boundPort: number = 0
  private noSecretWarned = false

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
  }

  stop(): void {
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

  // ── Webhook handler ───────────────────────────────────────────────

  private handleWebhook(
    name: string,
    body: any,
    headers: Record<string, string>,
    res: http.ServerResponse,
  ): void {
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
