import { type Connection, PublicKey, SENSOR_DISCRIMINATOR } from '@pumpking/anchor-client'
import type { ChainSensor, RegistryMirrorStore, RegistryRow } from '@pumpking/db'
import { encodeBase58 } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  diffRegistry,
  MIRROR_EVERY_MS,
  MIRROR_RETRY_MS,
  type RegistrySource,
  registryMirror,
  rpcRegistrySource,
} from './registry.ts'

/**
 * The mirror of the on-chain registry — `T076`.
 *
 * What is worth pinning down here is what reaches the database and when: a
 * row the chain disagrees with is rewritten, a row it agrees with is not, and
 * a failed read neither writes nor waits a full period to be tried again.
 */

const CELL_ID = 613_196_570_331_971_583n
const key = (fill: number): PublicKey => new PublicKey(new Uint8Array(32).fill(fill))

function sensor(fill: number, overrides: Partial<ChainSensor> = {}): ChainSensor {
  return {
    pubkey: key(fill).toBase58(),
    operatorWallet: key(100 + fill).toBase58(),
    cellId: CELL_ID,
    slotInCell: fill,
    stake: 1_000_000n,
    accepted: 0,
    outliers: 0,
    active: true,
    ...overrides,
  }
}

const row = (chain: ChainSensor, mirrored = true): RegistryRow => ({ ...chain, mirrored })

describe('diffRegistry', () => {
  it('writes a sensor the database has never seen', () => {
    const fresh = sensor(1)
    expect(diffRegistry([fresh], [])).toEqual({ changed: [fresh], missing: [] })
  })

  it('writes nothing when every row already says what the chain says', () => {
    const one = sensor(1)
    expect(diffRegistry([one], [row(one)])).toEqual({ changed: [], missing: [] })
  })

  it('writes a sensor whose stake or exclusion changed on chain — FR-050, FR-012', () => {
    const staked = sensor(1, { stake: 2_000_000n })
    const excluded = sensor(2, { active: false })
    const rows = [row(sensor(1)), row(sensor(2))]
    expect(diffRegistry([staked, excluded], rows).changed).toEqual([staked, excluded])
  })

  it('takes over a row the scenario door wrote, whatever slot the fixture gave it', () => {
    // The program handed out slot 4; the fixture had said 0. The mask is
    // indexed by the program's answer, so the row is rewritten even though
    // stake, operator and cell happen to agree.
    const onChain = sensor(1, { slotInCell: 4 })
    const fixture = row(sensor(1, { slotInCell: 0 }), false)
    expect(diffRegistry([onChain], [fixture]).changed).toEqual([onChain])
  })

  it('rewrites a row that agrees but was never marked as mirrored', () => {
    const one = sensor(1)
    expect(diffRegistry([one], [row(one, false)]).changed).toEqual([one])
  })

  it('reports a mirrored sensor the scan no longer returns, and leaves the rest alone', () => {
    const gone = row(sensor(1))
    const scenarioOnly = row(sensor(2), false)
    expect(diffRegistry([], [gone, scenarioOnly])).toEqual({
      changed: [],
      missing: [gone.pubkey],
    })
  })
})

/** The chain and the database, in memory, counting what each was asked. */
class Registry implements RegistrySource, RegistryMirrorStore {
  chain: ChainSensor[] = []
  rows: RegistryRow[] = []
  reads = 0
  writes: { rows: ChainSensor[]; at: Date }[] = []
  fail = false

  sensors(): Promise<ChainSensor[]> {
    this.reads += 1
    if (this.fail) return Promise.reject(new Error('429 Too Many Requests'))
    return Promise.resolve(this.chain)
  }
  sensorRows(): Promise<RegistryRow[]> {
    return Promise.resolve(this.rows)
  }
  mirrorSensors(rows: readonly ChainSensor[], at: Date): Promise<void> {
    this.writes.push({ rows: [...rows], at })
    const written = new Set(rows.map((one) => one.pubkey))
    this.rows = [
      ...this.rows.filter((one) => !written.has(one.pubkey)),
      ...rows.map((one) => row(one)),
    ]
    return Promise.resolve()
  }
}

describe('registryMirror', () => {
  const T0 = new Date('2026-09-29T10:00:00Z')
  const after = (ms: number): Date => new Date(T0.getTime() + ms)
  let registry: Registry

  beforeEach(() => {
    registry = new Registry()
  })

  it('reads at once, then once a period', async () => {
    registry.chain = [sensor(1), sensor(2)]
    const mirror = registryMirror(registry, registry)
    expect(mirror.synced).toBe(false)

    expect(await mirror.syncIfDue(T0)).toEqual({
      status: 'mirrored',
      onChain: 2,
      written: 2,
      missing: [],
    })
    expect(mirror.synced).toBe(true)
    expect(registry.writes[0]?.at).toEqual(T0)

    expect(await mirror.syncIfDue(after(MIRROR_EVERY_MS - 1))).toBeNull()
    expect(registry.reads).toBe(1)

    // Nothing changed on chain: read again, write nothing.
    expect(await mirror.syncIfDue(after(MIRROR_EVERY_MS))).toMatchObject({ written: 0 })
    expect(registry.reads).toBe(2)
    expect(registry.writes.at(-1)?.rows).toEqual([])
  })

  it('follows a stake that changed between two reads', async () => {
    registry.chain = [sensor(1, { stake: 0n })]
    const mirror = registryMirror(registry, registry)
    await mirror.syncIfDue(T0)

    registry.chain = [sensor(1, { stake: 1_000_000n })]
    await mirror.syncIfDue(after(MIRROR_EVERY_MS))
    expect(registry.rows.map((one) => one.stake)).toEqual([1_000_000n])
  })

  it('tries a failed read again after the retry interval, not a full period', async () => {
    registry.fail = true
    const mirror = registryMirror(registry, registry)

    const failed = await mirror.syncIfDue(T0)
    expect(failed?.status).toBe('failed')
    expect(mirror.synced).toBe(false)
    expect(registry.writes).toEqual([])

    expect(await mirror.syncIfDue(after(MIRROR_RETRY_MS - 1))).toBeNull()
    registry.fail = false
    expect((await mirror.syncIfDue(after(MIRROR_RETRY_MS)))?.status).toBe('mirrored')
    expect(mirror.synced).toBe(true)
  })

  it('stays synced after a later read fails — the last registry still stands', async () => {
    const mirror = registryMirror(registry, registry)
    await mirror.syncIfDue(T0)
    registry.fail = true
    await mirror.syncIfDue(after(MIRROR_EVERY_MS))
    expect(mirror.synced).toBe(true)
  })

  it('refuses a period that is not one', () => {
    expect(() => registryMirror(registry, registry, 0)).toThrow(RangeError)
    expect(() => registryMirror(registry, registry, 1_000, 0.5)).toThrow(RangeError)
  })
})

/* -------------------------------------------------------------------------- */
/* Reading the cluster                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A `Sensor` account, laid out by hand from `state.rs` rather than by the
 * coder the source decodes with — a second reading of the layout, so a
 * decoder that drifted from the program fails here instead of mirroring
 * plausible numbers from the wrong offsets.
 */
function sensorAccountBytes(input: {
  sensorKey: PublicKey
  operator: PublicKey
  cellId: bigint
  slotInCell: number
  stake: bigint
  unstaking: bigint
  unlockAtDay: number | null
  accepted: number
  outliers: number
  active: boolean
}): Uint8Array {
  const optional = input.unlockAtDay === null ? 1 : 5
  const bytes = new Uint8Array(8 + 32 + 32 + 8 + 1 + 8 + 8 + optional + 4 + 4 + 1 + 1)
  const view = new DataView(bytes.buffer)
  let at = 0
  bytes.set(SENSOR_DISCRIMINATOR, at)
  at += 8
  bytes.set(input.sensorKey.toBytes(), at)
  at += 32
  bytes.set(input.operator.toBytes(), at)
  at += 32
  view.setBigUint64(at, input.cellId, true)
  at += 8
  view.setUint8(at, input.slotInCell)
  at += 1
  view.setBigUint64(at, input.stake, true)
  at += 8
  view.setBigUint64(at, input.unstaking, true)
  at += 8
  if (input.unlockAtDay === null) {
    view.setUint8(at, 0)
    at += 1
  } else {
    view.setUint8(at, 1)
    view.setUint32(at + 1, input.unlockAtDay, true)
    at += 5
  }
  view.setUint32(at, input.accepted, true)
  at += 4
  view.setUint32(at, input.outliers, true)
  at += 4
  view.setUint8(at, input.active ? 1 : 0)
  at += 1
  view.setUint8(at, 253)
  return bytes
}

describe('rpcRegistrySource', () => {
  it('scans the program for Sensor accounts and reads every field the mirror keeps', async () => {
    const asked: { program: PublicKey; config: unknown }[] = []
    const program = key(77)
    const connection = {
      getProgramAccounts(programId: PublicKey, config: unknown) {
        asked.push({ program: programId, config })
        return Promise.resolve([
          {
            pubkey: key(50),
            account: {
              data: sensorAccountBytes({
                sensorKey: key(1),
                operator: key(2),
                cellId: CELL_ID,
                slotInCell: 31,
                stake: 18_446_744_073_709_551_615n,
                unstaking: 7n,
                unlockAtDay: 900,
                accepted: 12,
                outliers: 3,
                active: false,
              }),
            },
          },
          {
            pubkey: key(51),
            account: {
              data: sensorAccountBytes({
                sensorKey: key(3),
                operator: key(2),
                cellId: CELL_ID,
                slotInCell: 0,
                stake: 0n,
                unstaking: 0n,
                unlockAtDay: null,
                accepted: 0,
                outliers: 0,
                active: true,
              }),
            },
          },
        ])
      },
    } as unknown as Connection

    const sensors = await rpcRegistrySource(connection, program).sensors()

    expect(asked).toHaveLength(1)
    expect(asked[0]?.program.equals(program)).toBe(true)
    expect(asked[0]?.config).toEqual({
      filters: [{ memcmp: { offset: 0, bytes: encodeBase58(SENSOR_DISCRIMINATOR) } }],
    })
    expect(sensors).toEqual([
      {
        pubkey: key(1).toBase58(),
        operatorWallet: key(2).toBase58(),
        cellId: CELL_ID,
        slotInCell: 31,
        // u64 end to end: a stake past 2^53 must not round.
        stake: 18_446_744_073_709_551_615n,
        accepted: 12,
        outliers: 3,
        active: false,
      },
      {
        pubkey: key(3).toBase58(),
        operatorWallet: key(2).toBase58(),
        cellId: CELL_ID,
        slotInCell: 0,
        stake: 0n,
        accepted: 0,
        outliers: 0,
        active: true,
      },
    ])
  })
})
