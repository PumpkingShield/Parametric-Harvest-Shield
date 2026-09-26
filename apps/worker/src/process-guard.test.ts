import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Logger } from 'pino'
import { describe, expect, it } from 'vitest'
import { guardProcess } from './process-guard.ts'

type Line = { level: 'error' | 'fatal'; fields: unknown; message: string }

function harness() {
  const lines: Line[] = []
  const exits: number[] = []
  const emitter = new EventEmitter()
  const target = Object.assign(emitter, {
    exit(code: number) {
      exits.push(code)
    },
  })
  const log = {
    error(fields: unknown, message: string) {
      lines.push({ level: 'error', fields, message })
    },
    fatal(fields: unknown, message: string) {
      lines.push({ level: 'fatal', fields, message })
    },
  } as unknown as Logger
  guardProcess(target, log)
  return { emitter, lines, exits }
}

describe('guardProcess', () => {
  it('logs a rejection nobody awaited and does not exit', () => {
    const { emitter, lines, exits } = harness()
    const reason = new Error('429 : Too many requests for a specific RPC call')

    emitter.emit('unhandledRejection', reason)

    expect(exits).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('error')
    expect(lines[0]?.fields).toEqual({ err: reason })
  })

  it('logs an uncaught exception and exits with 1', () => {
    const { emitter, lines, exits } = harness()
    const error = new Error('half-done')

    emitter.emit('uncaughtException', error)

    expect(exits).toEqual([1])
    expect(lines.map((line) => line.level)).toEqual(['fatal'])
    expect(lines[0]?.fields).toEqual({ err: error })
  })
})

/**
 * The same thing in a real Node process, where the default is what it is.
 *
 * The first case is the witness: without the guard, the process must die on an
 * unawaited rejection. If it ever stops dying — a Node that changes its default
 * — the second case proves nothing, and this is where that shows.
 */
describe('guardProcess in a real process', () => {
  const guard = new URL('./process-guard.ts', import.meta.url).href

  // A rejection with no awaiter, the shape web3.js leaves behind, then a timer
  // that only fires if the process is still alive to run it.
  const body = `
    void (async () => { throw new Error('429 : Too many requests') })()
    setTimeout(() => { process.stdout.write('alive'); process.exit(0) }, 50)
  `

  function run(script: string) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    })
  }

  it('dies on an unawaited rejection without the guard', () => {
    const result = run(body)
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('alive')
  })

  it('survives it with the guard, and says so', () => {
    const result = run(`
      import { guardProcess } from '${guard}'
      const log = {
        error: (_fields, message) => process.stderr.write(message + '\\n'),
        fatal: (_fields, message) => process.stderr.write(message + '\\n'),
      }
      guardProcess(process, log)
      ${body}
    `)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('alive')
    expect(result.stderr).toContain('a promise nobody awaited was rejected')
  })
})
