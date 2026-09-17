import { Keypair, PROGRAM_ID } from '@pumpking/anchor-client'
import { encodeBase58 } from '@pumpking/shared'
import { describe, expect, it } from 'vitest'
import { ConfigError, parseKeypair, readWorkerConfig } from './config.ts'

const AGGREGATOR = Keypair.generate()

const MINIMUM = {
  DATABASE_URL: 'postgresql://user:pass@host:6543/postgres',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  AGGREGATOR_KEYPAIR: JSON.stringify([...AGGREGATOR.secretKey]),
}

describe('parseKeypair', () => {
  it('reads the JSON array solana-keygen writes', () => {
    const parsed = parseKeypair(JSON.stringify([...AGGREGATOR.secretKey]))
    expect(parsed.publicKey.equals(AGGREGATOR.publicKey)).toBe(true)
  })

  it('reads the base58 a secret manager holds on one line', () => {
    const parsed = parseKeypair(encodeBase58(AGGREGATOR.secretKey))
    expect(parsed.publicKey.equals(AGGREGATOR.publicKey)).toBe(true)
  })

  it('refuses anything that is not 64 bytes', () => {
    // A key read wrong is a signature by nobody, and every day record after it
    // is rejected for a reason that has nothing to do with the day.
    expect(() => parseKeypair('[1,2,3]')).toThrow(/64 bytes/)
    expect(() => parseKeypair(encodeBase58(AGGREGATOR.publicKey.toBytes()))).toThrow(/64 bytes/)
    expect(() => parseKeypair('not a key at all')).toThrow(/64 bytes/)
  })
})

describe('readWorkerConfig', () => {
  it('needs a database, an RPC endpoint and the aggregator', () => {
    try {
      readWorkerConfig({})
      expect.unreachable('an empty environment is not usable')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message).toContain('DATABASE_URL')
      expect(message).toContain('SOLANA_RPC_URL')
      expect(message).toContain('AGGREGATOR_KEYPAIR')
    }
  })

  it('says which part of the keypair it could not read', () => {
    expect(() => readWorkerConfig({ ...MINIMUM, AGGREGATOR_KEYPAIR: 'nonsense' })).toThrow(
      ConfigError,
    )
  })

  it('asks for no clock and no thresholds', () => {
    // `genesis_ts`, `seconds_per_day`, the dry threshold and the vote count are
    // fields of the on-chain pool, and the worker reads them from it. A
    // variable that could disagree with the program about which day it is has
    // no business existing.
    const config = readWorkerConfig(MINIMUM)
    expect(Object.keys(config)).not.toContain('genesisTs')
    expect(Object.keys(config)).not.toContain('secondsPerDay')
    expect(Object.keys(config)).not.toContain('dryThresholdX100')
  })

  it('defaults what the chain does not publish', () => {
    const config = readWorkerConfig(MINIMUM)
    expect(config.intervalsPerDay).toBe(24)
    expect(config.minimumCoverageX100).toBe(75)
    expect(config.backlogDays).toBe(7)
    expect(config.port).toBe(8081)
    expect(config.programId.equals(PROGRAM_ID)).toBe(true)
    expect(config.aggregator.publicKey.equals(AGGREGATOR.publicKey)).toBe(true)
  })

  it('has no keep-alive unless one is named', () => {
    expect(readWorkerConfig(MINIMUM).keepAliveUrl).toBeNull()
    expect(readWorkerConfig({ ...MINIMUM, KEEPALIVE_URL: '  ' }).keepAliveUrl).toBeNull()
    expect(
      readWorkerConfig({ ...MINIMUM, KEEPALIVE_URL: 'https://api.app/health' }).keepAliveUrl,
    ).toBe('https://api.app/health')
  })

  it('refuses a coverage fraction that is not one', () => {
    expect(() => readWorkerConfig({ ...MINIMUM, MINIMUM_COVERAGE_X100: '101' })).toThrow(
      ConfigError,
    )
    expect(readWorkerConfig({ ...MINIMUM, MINIMUM_COVERAGE_X100: '0' }).minimumCoverageX100).toBe(0)
  })

  it('refuses a backlog of zero days', () => {
    // `closeDueDays` refuses it too, at runtime, one cycle later.
    expect(() => readWorkerConfig({ ...MINIMUM, BACKLOG_DAYS: '0' })).toThrow(ConfigError)
  })

  it('ignores everything else in the environment', () => {
    expect(() => readWorkerConfig({ ...MINIMUM, PATH: '/usr/bin' })).not.toThrow()
  })
})
