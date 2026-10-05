import type {
  CounterStore,
  ReadingRow,
  ReadingStore,
  RegistryRow,
  RegistryStore,
  SaveOutcome,
  SensorRegistration,
} from '@pumpking/db'
import { ReadingKind } from '@pumpking/shared'
import { feederCellId, feederSensors, HOUR_MS, hourOf } from '@pumpking/worker/feeder'
import { beforeAll, describe, expect, it } from 'vitest'
import { readApiConfig } from '../config.ts'
import { createFeederRoute, type FeederTickWire } from './feeder.ts'
import { createReadingsRoute } from './readings.ts'
import { type ReadingPublisher, routeReadingPublisher } from './scenario.ts'

/**
 * The feeder through the real door: every reading it makes is parsed,
 * signature-checked and counter-checked by the readings route, against a
 * registry the chain filled — here, as the mirror would have left it after
 * `scripts/devnet-register.mjs --set feeder`.
 */

const TOKEN = 'a-feeder-token-that-is-long-enough-to-pass'
const OPERATOR = 'Vote111111111111111111111111111111111111111'
const MIN_STAKE = 1_000_000n
const HOUR = hourOf(new Date('2026-10-01T10:00:00Z'))

/** The hundred sensors as the mirror holds them once they are registered and staked. */
let MIRRORED: RegistryRow[] = []
beforeAll(async () => {
  MIRRORED = (await feederSensors()).map((sensor) => ({
    pubkey: sensor.pubkey,
    operatorWallet: OPERATOR,
    cellId: feederCellId(sensor),
    slotInCell: Math.floor((sensor.seed - 101) / 4),
    previousCellId: null,
    previousSlot: null,
    movedAt: null,
    stake: MIN_STAKE,
    accepted: 0,
    outliers: 0,
    active: true,
    mirrored: true,
  }))
})

/** Registry and intake over one set of rows, as in Postgres. */
class Storage implements RegistryStore, ReadingStore, CounterStore {
  registry = new Map<string, RegistryRow>()
  registrations = new Map<string, SensorRegistration>()
  rows: ReadingRow[] = []
  /** How many times the registry was read. */
  asked = 0

  constructor(rows: readonly RegistryRow[]) {
    for (const row of rows) {
      this.registry.set(row.pubkey, row)
      this.registrations.set(row.pubkey, {
        pubkey: row.pubkey,
        cellId: row.cellId,
        kind: ReadingKind.PrecipitationMm,
        active: row.active,
      })
    }
  }

  rowsOf(pubkeys: readonly string[]): Promise<RegistryRow[]> {
    this.asked += 1
    return Promise.resolve(
      pubkeys.flatMap((pubkey) => {
        const row = this.registry.get(pubkey)
        return row === undefined ? [] : [row]
      }),
    )
  }

  sensorFor(pubkey: string): Promise<SensorRegistration | null> {
    return Promise.resolve(this.registrations.get(pubkey) ?? null)
  }

  save(row: ReadingRow): Promise<SaveOutcome> {
    const existing = this.rows.find(
      (one) => one.sensorPubkey === row.sensorPubkey && one.counter === row.counter,
    )
    if (existing !== undefined) {
      return Promise.resolve({
        stored: false,
        existingSignature: existing.signature,
        status: existing.status,
      })
    }
    this.rows.push(row)
    return Promise.resolve({ stored: true, status: row.status })
  }

  lastCounters(pubkeys: readonly string[]): Promise<Map<string, bigint>> {
    const wanted = new Set(pubkeys)
    const last = new Map<string, bigint>()
    for (const row of this.rows) {
      if (!wanted.has(row.sensorPubkey)) continue
      const seen = last.get(row.sensorPubkey)
      if (seen === undefined || row.counter > seen) last.set(row.sensorPubkey, row.counter)
    }
    return Promise.resolve(last)
  }
}

function feeder(
  options: {
    token?: string | null
    publisher?: ReadingPublisher
    registry?: readonly RegistryRow[]
  } = {},
) {
  let clock = HOUR * HOUR_MS + 5 * 60_000
  const now = () => new Date(clock)
  const storage = new Storage(options.registry ?? MIRRORED)
  const readings = createReadingsRoute({ store: storage, now })
  const app = createFeederRoute({
    token: options.token === undefined ? TOKEN : options.token,
    registry: storage,
    minStake: () => Promise.resolve(MIN_STAKE),
    counters: storage,
    publisher: options.publisher ?? routeReadingPublisher(readings),
    now,
  })
  const tick = async (token = TOKEN) =>
    await app.request('/tick', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  const body = async (token = TOKEN) => (await (await tick(token)).json()) as FeederTickWire
  const advance = (ms: number) => {
    clock += ms
  }
  return { storage, tick, body, advance }
}

describe('POST /v1/feeder/tick', () => {
  it('is not there without a token', async () => {
    const { tick } = feeder({ token: null })
    expect((await tick()).status).toBe(404)
  })

  it('refuses a caller without the token', async () => {
    const { tick, storage } = feeder()
    expect((await tick('wrong')).status).toBe(401)
    expect(storage.rows).toEqual([])
  })

  it('publishes the current hour through intake', async () => {
    const { body, storage } = feeder()
    const tally = await body()

    expect(tally).toEqual({
      synthetic: true,
      hours: [HOUR],
      sent: 100,
      stored: 100,
      repeated: 0,
      refused: 0,
    })
    expect(storage.rows.every((row) => row.status === 'accepted')).toBe(true)
  })

  it('sends nothing on a tick inside an hour already published', async () => {
    const { body, advance } = feeder()
    await body()
    advance(20 * 60_000)
    expect((await body()).sent).toBe(0)
  })

  it('checks the registry once per process, not once per tick', async () => {
    const { body, storage, advance } = feeder()
    await body()
    advance(HOUR_MS)
    await body()
    expect(storage.asked).toBe(1)
  })

  /**
   * `FR-050`, `T077`: a load whose readings count for nothing measures the
   * traffic and none of the work. Refused, said how many and why, and asked
   * again on the next tick rather than remembered.
   */
  it('refuses to speak until every sensor votes, and asks again next tick', async () => {
    const [first, ...rest] = MIRRORED
    if (first === undefined) throw new Error('fixture')
    const registry = [{ ...first, stake: MIN_STAKE - 1n }, ...rest.slice(1)]
    const { tick, storage } = feeder({ registry })

    const response = await tick()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { details: { sensors: 2, byProblem: { understaked: 1, unregistered: 1 } } },
    })
    expect(storage.rows).toEqual([])

    await tick()
    expect(storage.asked).toBe(2)
  })

  it('catches up after missed ticks, and leaves out what intake would file as late', async () => {
    const { body, advance, storage } = feeder()
    await body()
    // Three hours of silence: hour +1 is past the ninety-minute window by now.
    advance(3 * HOUR_MS)
    const tally = await body()

    expect(tally.hours).toEqual([HOUR + 1, HOUR + 2, HOUR + 3])
    expect(tally.stored).toBe(200)
    expect(tally.refused).toBe(0)
    expect(storage.rows.some((row) => row.status === 'late')).toBe(false)
  })

  it('finishes an interrupted hour; what intake already has comes back as a retry', async () => {
    const { body, storage, advance } = feeder()
    await body()
    advance(HOUR_MS)
    await body()
    // Half of the last hour lost, as if the process died mid-tick.
    const lastHour = BigInt(HOUR + 1)
    const kept = storage.rows.filter((row) => row.counter !== lastHour)
    const half = storage.rows.filter((row) => row.counter === lastHour).slice(0, 50)
    storage.rows = [...kept, ...half]

    advance(10 * 60_000)
    const tally = await body()
    expect(tally).toMatchObject({ hours: [HOUR + 1], stored: 50, repeated: 50, refused: 0 })
  })

  it('lets one tick run at a time', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: ReadingPublisher = {
      publish: async () => {
        await gate
        return { ok: true, status: 201 }
      },
    }
    const { tick } = feeder({ publisher: slow })

    const first = tick()
    // Let the first one reach its publish before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await tick()).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
  })
})

describe('the feeder configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', SOLANA_RPC_URL: 'https://api.devnet.solana.com' }

  it('is off without a token', () => {
    expect(readApiConfig(base).feeder).toBeNull()
  })

  it('refuses a short token', () => {
    expect(() => readApiConfig({ ...base, FEEDER_TOKEN: 'short' })).toThrow(/FEEDER_TOKEN/)
  })

  it('needs no operator wallets since T077 — the chain names them', () => {
    const config = readApiConfig({ ...base, FEEDER_TOKEN: TOKEN, FEEDER_OPERATORS: 'ignored' })
    expect(config.feeder).toEqual({ token: TOKEN })
  })
})
