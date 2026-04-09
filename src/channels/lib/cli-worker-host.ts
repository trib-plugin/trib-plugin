import { spawn } from 'child_process'

type CliResult = { stdout: string, stderr: string, code: number | null }
type CliTask = {
  command: string
  args?: string[]
  stdin?: string
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

export function hasCliWorker(): boolean {
  return true // always available — direct spawn, no worker needed
}

export function startCliWorker(_options?: Record<string, unknown>): void {
  // no-op — worker removed, using direct spawn
}

export async function stopCliWorker(): Promise<void> {
  // no-op
}

export function runCliWorkerTask(task: CliTask | Record<string, unknown>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const command = String((task as CliTask).command ?? '').trim()
    const args = Array.isArray((task as CliTask).args) ? (task as CliTask).args!.map(String) : []
    const timeoutMs = Math.max(1000, Number((task as CliTask).timeout ?? 120000))
    const isWin = process.platform === 'win32'

    // Windows: quote args with spaces for shell mode
    const safeArgs = isWin ? args.map(a => /\s/.test(a) ? `"${a}"` : a) : args

    const child = spawn(command, safeArgs, {
      cwd: (task as CliTask).cwd ?? process.cwd(),
      env: { ...process.env, ...((task as CliTask).env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
    })

    let stdout = ''
    let stderr = ''
    let finished = false

    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('error', (err: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(new Error(`spawn ${command} failed: ${err.message}`))
    })

    child.on('close', (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })

    // Send stdin if provided
    const stdin = (task as CliTask).stdin
    if (stdin != null) {
      child.stdin.write(String(stdin))
    }
    child.stdin.end()
  })
}
