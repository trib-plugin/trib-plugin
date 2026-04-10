/**
 * Settings utilities.
 */

import { readFileSync } from 'fs'

export function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}
