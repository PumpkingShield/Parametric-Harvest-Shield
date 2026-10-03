import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The subpaths the browser sensor imports (`T038`) stay free of the two heavy
 * dependencies of this package — `h3-js` (550 kB of asm.js) and Zod.
 *
 * A bundler would pull either in silently through one new relative import,
 * and the first sign would be a sensor page that takes ten seconds longer on
 * 3G. So the import graph is walked here, from source, the way a bundler
 * would walk it.
 */

const SRC = dirname(fileURLToPath(import.meta.url))

const IMPORT = /^(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm

/** Every package a module reaches, through any chain of relative imports. */
function packagesReachedFrom(entry: string): Set<string> {
  const packages = new Set<string>()
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(join(SRC, file), 'utf8')
    for (const match of source.matchAll(IMPORT)) {
      const target = match[1]
      if (target === undefined) continue
      if (target.startsWith('./')) queue.push(target.slice(2))
      else packages.add(target)
    }
  }
  return packages
}

describe('the modules the browser sensor imports', () => {
  for (const entry of ['reading-bytes.ts', 'signature.ts', 'cell-id.ts']) {
    it(`${entry} reaches neither h3-js nor zod`, () => {
      const reached = packagesReachedFrom(entry)
      expect(reached.has('h3-js')).toBe(false)
      expect(reached.has('zod')).toBe(false)
    })
  }

  it('the walk finds both where they are — the control for the tests above', () => {
    // `reading.ts` imports Zod itself, and `cell.ts` imports h3-js.
    expect(packagesReachedFrom('reading.ts').has('zod')).toBe(true)
    expect(packagesReachedFrom('index.ts').has('h3-js')).toBe(true)
    expect(packagesReachedFrom('signature.ts').has('@noble/ed25519')).toBe(true)
  })
})
