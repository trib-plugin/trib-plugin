/**
 * http-runner.mjs — HTTP direct runners for Ollama and API-key providers.
 * Already isolated by nature (no CLI context loading).
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export async function runOllamaHTTP(prompt, options = {}) {
  const { model = 'gemma4:e4b', timeout = 120000, baseUrl = 'http://localhost:11434' } = options

  const payload = JSON.stringify({
    model,
    prompt,
    stream: false,
    options: { num_ctx: 4096, temperature: 0 },
  })

  const { stdout } = await execFileAsync('curl', [
    '-s', '-f', '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-d', payload,
    `${baseUrl}/api/generate`,
  ], { timeout, maxBuffer: 10 * 1024 * 1024 })

  const data = JSON.parse(stdout || '{}')
  if (data.error) throw new Error(`Ollama error: ${data.error}`)
  if (!data.response) throw new Error('Ollama returned empty response')
  return data.response
}

export async function runHTTP(prompt, options = {}) {
  const {
    model, timeout = 180000, apiKey, baseUrl, provider = 'openai',
    systemPrompt = 'You are a helpful assistant.',
  } = options

  if (!apiKey) throw new Error(`API key required for ${provider}`)

  const isAnthropic = provider === 'anthropic' || /claude|anthropic/i.test(model || '')

  if (isAnthropic) {
    const endpoint = baseUrl ? `${baseUrl}/v1/messages` : 'https://api.anthropic.com/v1/messages'
    const payload = JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    })
    const { stdout } = await execFileAsync('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `x-api-key: ${apiKey}`,
      '-H', 'anthropic-version: 2023-06-01',
      '-d', payload,
      endpoint,
    ], { timeout, maxBuffer: 10 * 1024 * 1024 })
    const data = JSON.parse(stdout || '{}')
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    if (!text) throw new Error('Anthropic returned empty response')
    return text
  }

  // OpenAI-compatible
  const url = baseUrl || 'https://api.openai.com/v1'
  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  })
  const { stdout } = await execFileAsync('curl', [
    '-s', '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${apiKey}`,
    '-d', payload,
    `${url}/chat/completions`,
  ], { timeout, maxBuffer: 10 * 1024 * 1024 })
  const data = JSON.parse(stdout || '{}')
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`${provider} returned empty response`)
  return text
}
