import { PROGRAM_ID } from '@pumpking/anchor-client'
import { describe, expect, it } from 'vitest'
import { ConfigError, readApiConfig } from './config.ts'

const MINIMUM = {
  DATABASE_URL: 'postgresql://user:pass@host:6543/postgres',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
}

describe('readApiConfig', () => {
  it('needs a database and an RPC endpoint, and says which is missing', () => {
    expect(() => readApiConfig({})).toThrow(ConfigError)

    try {
      readApiConfig({})
      expect.unreachable('an empty environment is not usable')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message).toContain('DATABASE_URL')
      // Every problem at once: a process restarted three times to learn three
      // missing variables is three deploys.
      expect(message).toContain('SOLANA_RPC_URL')
    }
  })

  it('defaults the port, the program and the log level', () => {
    const config = readApiConfig(MINIMUM)
    expect(config.port).toBe(8080)
    expect(config.programId.equals(PROGRAM_ID)).toBe(true)
    expect(config.logLevel).toBe('info')
  })

  it('ignores everything else in the environment', () => {
    // It is handed `process.env`, which carries the whole shell.
    expect(() => readApiConfig({ ...MINIMUM, PATH: '/usr/bin', HOME: '/root' })).not.toThrow()
  })

  it('is off unless SCENARIO_MODE says on', () => {
    expect(readApiConfig(MINIMUM).scenarioMode).toBe(false)
    expect(readApiConfig({ ...MINIMUM, SCENARIO_MODE: 'off' }).scenarioMode).toBe(false)
    expect(readApiConfig({ ...MINIMUM, SCENARIO_MODE: 'on' }).scenarioMode).toBe(true)
  })

  it('refuses a scenario mode it cannot read', () => {
    // Not "anything that is not `on` is off": `SCENARIO_MODE=true` would then
    // silently disable the demo button, which is the failure that looks like a
    // broken deployment.
    expect(() => readApiConfig({ ...MINIMUM, SCENARIO_MODE: 'true' })).toThrow(ConfigError)
  })

  it('keeps the worker out of this process unless RUN_WORKER says on', () => {
    // `T056`: the free deployment has one web service and no background
    // worker, so the loop turns here. Everywhere else it is its own process,
    // and two loops writing the same day is the failure this guards.
    expect(readApiConfig(MINIMUM).runWorker).toBe(false)
    expect(readApiConfig({ ...MINIMUM, RUN_WORKER: 'off' }).runWorker).toBe(false)
    expect(readApiConfig({ ...MINIMUM, RUN_WORKER: 'on' }).runWorker).toBe(true)
  })

  it('refuses a RUN_WORKER it cannot read', () => {
    // The same reasoning as `SCENARIO_MODE`: read loosely, `RUN_WORKER=true`
    // would leave the aggregator not running while the deployment looks whole.
    expect(() => readApiConfig({ ...MINIMUM, RUN_WORKER: 'true' })).toThrow(ConfigError)
    expect(() => readApiConfig({ ...MINIMUM, RUN_WORKER: '1' })).toThrow(ConfigError)
  })

  it('refuses a port that is not one', () => {
    expect(() => readApiConfig({ ...MINIMUM, PORT: 'eight' })).toThrow(ConfigError)
    expect(() => readApiConfig({ ...MINIMUM, PORT: '0' })).toThrow(ConfigError)
    expect(readApiConfig({ ...MINIMUM, PORT: '3000' }).port).toBe(3000)
  })

  it('refuses an RPC url that is not a url', () => {
    expect(() => readApiConfig({ ...MINIMUM, SOLANA_RPC_URL: 'devnet' })).toThrow(ConfigError)
  })

  it('takes a program id when a second deployment needs one', () => {
    const other = 'Vote111111111111111111111111111111111111111'
    expect(readApiConfig({ ...MINIMUM, PUMPKING_PROGRAM_ID: other }).programId.toBase58()).toBe(
      other,
    )
    expect(() => readApiConfig({ ...MINIMUM, PUMPKING_PROGRAM_ID: 'not a key' })).toThrow(
      ConfigError,
    )
  })

  it('splits a list of origins and keeps a bare star as one', () => {
    expect(readApiConfig(MINIMUM).webOrigin).toBe('*')
    expect(
      readApiConfig({ ...MINIMUM, WEB_ORIGIN: 'https://a.app, https://b.app' }).webOrigin,
    ).toEqual(['https://a.app', 'https://b.app'])
  })
})
