/**
 * Serialization queue for config.json writes.
 *
 * Both discord.ts saveAccess() and custom-commands.ts savePluginConfig()
 * perform read-modify-write on the same config.json. This lock ensures
 * those operations never overlap.
 */

let pending: Promise<void> = Promise.resolve()

export function withConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = pending.then(() => fn())
  pending = next.then(() => {}, (e) => { process.stderr.write(`[config-lock] Error: ${e}\n`) })
  return next
}
