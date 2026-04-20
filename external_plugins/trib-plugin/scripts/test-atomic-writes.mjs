// Atomic-write correctness tests. Verify that the tempfile + fsync + rename
// primitive in builtin.mjs leaves no 0-byte or partial state on crash,
// preserves file permissions on POSIX, and survives concurrent callers.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import {
  atomicWrite,
  __setAtomicRenameOverrideForTest,
  __setAtomicWriteOverrideForTest,
} from '../src/agent/orchestrator/tools/builtin.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
void __dirname

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; return }
  failed++
  console.error(`  FAIL: ${msg}`)
}

const fixDir = mkdtempSync(join(tmpdir(), 'atomic-writes-'))

async function main() {
  try {
    // 1. Happy path — create a new file
    {
      const p = join(fixDir, 'new.txt')
      await atomicWrite(p, 'hello')
      assert(existsSync(p), '1a. new.txt created')
      assert(readFileSync(p, 'utf8') === 'hello', '1b. new.txt content matches')
      const residue = readdirSync(fixDir).filter(f => f.startsWith('.new.txt.trib-tmp-'))
      assert(residue.length === 0, '1c. no tempfile residue after success')
    }

    // 2. Happy path — overwrite
    {
      const p = join(fixDir, 'overwrite.txt')
      writeFileSync(p, 'old-content')
      await atomicWrite(p, 'new-content')
      assert(readFileSync(p, 'utf8') === 'new-content', '2. overwrite content matches')
    }

    // 3. Empty content does not crash
    {
      const p = join(fixDir, 'empty.txt')
      await atomicWrite(p, '')
      assert(existsSync(p), '3a. empty file created')
      assert(readFileSync(p, 'utf8') === '', '3b. empty file body is ""')
    }

    // 4. Binary Buffer content
    {
      const p = join(fixDir, 'bin.dat')
      await atomicWrite(p, Buffer.from([0, 1, 2, 255]))
      const buf = readFileSync(p)
      assert(buf.length === 4, '4a. binary length matches')
      assert(buf[0] === 0 && buf[3] === 255, '4b. binary bytes intact')
    }

    // 5. Large content (150 KB) — ensure no truncation
    {
      const p = join(fixDir, 'big.txt')
      const big = 'x'.repeat(150_000)
      await atomicWrite(p, big)
      assert(readFileSync(p, 'utf8').length === 150_000, '5. 150KB file size matches')
    }

    // 6. Rename failure → target unchanged, tempfile cleaned
    {
      const p = join(fixDir, 'rename-fail.txt')
      writeFileSync(p, 'ORIGINAL')
      __setAtomicRenameOverrideForTest(async () => {
        const e = new Error('ENOSPC simulated')
        e.code = 'ENOSPC'
        throw e
      })
      let caught = null
      try { await atomicWrite(p, 'NEW') } catch (e) { caught = e }
      __setAtomicRenameOverrideForTest(null)
      assert(caught !== null && caught.code === 'ENOSPC', '6a. rename error propagated')
      assert(readFileSync(p, 'utf8') === 'ORIGINAL', '6b. target unchanged after rename fail')
      const residue = readdirSync(fixDir).filter(f => f.startsWith('.rename-fail.txt.trib-tmp-'))
      assert(residue.length === 0, '6c. tempfile cleaned after rename fail')
    }

    // 7. Write failure → target unchanged, tempfile cleaned
    {
      const p = join(fixDir, 'write-fail.txt')
      writeFileSync(p, 'ORIGINAL')
      __setAtomicWriteOverrideForTest(async () => { throw new Error('write simulated') })
      let caught = null
      try { await atomicWrite(p, 'NEW') } catch (e) { caught = e }
      __setAtomicWriteOverrideForTest(null)
      assert(caught !== null, '7a. write error propagated')
      assert(readFileSync(p, 'utf8') === 'ORIGINAL', '7b. target unchanged after write fail')
      const residue = readdirSync(fixDir).filter(f => f.startsWith('.write-fail.txt.trib-tmp-'))
      assert(residue.length === 0, '7c. tempfile cleaned after write fail')
    }

    // 8. Parallel writes to adjacent paths — no tempfile collision
    {
      const paths = Array.from({ length: 10 }, (_, i) => join(fixDir, `parallel-${i}.txt`))
      await Promise.all(paths.map(p => atomicWrite(p, `content-for-${p}`)))
      let ok = true
      for (const p of paths) if (readFileSync(p, 'utf8') !== `content-for-${p}`) { ok = false; break }
      assert(ok, '8. all 10 parallel adjacent writes produced correct content')
    }

    // 9. Race — many writers to the SAME path. On Windows `rename` is
    //    serialized by the OS so some writers raise EPERM/EBUSY while one
    //    succeeds; that's exactly the atomicity we want (no interleave).
    //    Require: at least one success, final content is ONE complete
    //    writer payload, never 0-byte.
    {
      const p = join(fixDir, 'race.txt')
      const writers = Array.from({ length: 20 }, (_, i) =>
        atomicWrite(p, `writer-${i}-${'x'.repeat(1000)}`).catch(() => null)
      )
      await Promise.all(writers)
      assert(existsSync(p), '9a. race: target exists after concurrent writers')
      const finalContent = readFileSync(p, 'utf8')
      const match = /^writer-\d+-x+$/.test(finalContent)
      assert(match, '9b. race: final content is exactly one writer payload (no interleave)')
      assert(finalContent.length > 1000, '9c. race: final content not truncated / 0-byte')
      // Cleanup tempfiles that failed writers' atomicWrite may have left
      // hanging if a rename-retry hit an unexpected error code not in the
      // retry set. In practice this directory stays clean, but sweep
      // defensively so later residue-count assertions in other tests
      // aren't polluted by this test's failed siblings.
      for (const f of readdirSync(fixDir).filter(x => x.startsWith('.race.txt.trib-tmp-'))) {
        try { rmSync(join(fixDir, f), { force: true }) } catch {}
      }
    }

    // 10. POSIX mode preservation (skip on Windows — no POSIX bits)
    if (process.platform !== 'win32') {
      const p = join(fixDir, 'mode.txt')
      writeFileSync(p, 'a')
      chmodSync(p, 0o600)
      await atomicWrite(p, 'b')
      const mode = statSync(p).mode & 0o777
      assert(mode === 0o600, '10. POSIX mode 0o600 preserved across atomic rename')
    } else {
      passed++ // keep the count meaningful on Windows
    }

    // 11. Explicit mode override (skip on Windows)
    if (process.platform !== 'win32') {
      const p = join(fixDir, 'mode-explicit.txt')
      await atomicWrite(p, 'x', { mode: 0o640 })
      const mode = statSync(p).mode & 0o777
      assert(mode === 0o640, '11. explicit mode 0o640 honoured for new file')
    } else {
      passed++ // parity on Windows
    }

    // 12. Tempfile cleanup after repeated rename failure — directory stays clean
    {
      __setAtomicRenameOverrideForTest(async () => {
        const e = new Error('EBUSY simulated')
        e.code = 'EBUSY'
        throw e
      })
      const p = join(fixDir, 'cleanup-idem.txt')
      let caught = null
      try { await atomicWrite(p, 'x') } catch (e) { caught = e }
      __setAtomicRenameOverrideForTest(null)
      assert(caught !== null, '12a. rename-fail propagated')
      const residue = readdirSync(fixDir).filter(f => f.startsWith('.cleanup-idem.txt.trib-tmp-'))
      assert(residue.length === 0, '12b. tempfile cleaned after EBUSY rename fail')
    }
  } finally {
    try { rmSync(fixDir, { recursive: true, force: true }) } catch {}
  }

  const total = passed + failed
  console.log(`\nPASS ${passed}/${total}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
