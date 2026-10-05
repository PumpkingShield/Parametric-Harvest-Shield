import type { RegistryRow, RegistryStore } from '@pumpking/db'
import { cellIdFromH3Index, sensorPublicKey } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FieldsBody } from '../errors.ts'
import { createSensorsRoute, type SensorWire } from './sensors.ts'

const H3 = '871e701b3ffffff'
const NEIGHBOUR = '871e701b2ffffff'
const MIN_STAKE = 1_000_000n

let rows: RegistryRow[]
let minStake: bigint | null
let pubkey: string

const registry: RegistryStore = {
  rowsOf: (pubkeys) => Promise.resolve(rows.filter((row) => pubkeys.includes(row.pubkey))),
}

beforeEach(async () => {
  pubkey = await sensorPublicKey(new Uint8Array(32).fill(9))
  minStake = MIN_STAKE
  rows = [
    {
      pubkey,
      operatorWallet: 'operator',
      cellId: cellIdFromH3Index(H3),
      slotInCell: 0,
      previousCellId: null,
      previousSlot: null,
      movedAt: null,
      stake: MIN_STAKE,
      accepted: 0,
      outliers: 0,
      active: true,
      mirrored: true,
    },
  ]
})

async function get(key: string): Promise<Response> {
  const route = createSensorsRoute({ registry, minStake: () => Promise.resolve(minStake) })
  return await route.request(`/${key}`)
}

async function sensor(): Promise<SensorWire> {
  const response = await get(pubkey)
  expect(response.status).toBe(200)
  return (await response.json()) as SensorWire
}

describe('GET /v1/sensors/:pubkey', () => {
  it('names the cell the registration fixed, in the hex a reading carries', async () => {
    expect(await sensor()).toEqual({
      pubkey,
      cellId: H3,
      previousCellId: null,
      movedAt: null,
      stake: '1000000',
      minStake: '1000000',
      voting: true,
      problem: null,
    })
  })

  it('names the cell a moved key left and when, for the votes and the earnings left there — FR-059', async () => {
    const [row] = rows
    if (row === undefined) throw new Error('no row')
    const movedAt = new Date('2026-10-05T12:30:00.000Z')
    rows = [
      {
        ...row,
        cellId: cellIdFromH3Index(NEIGHBOUR),
        slotInCell: 3,
        previousCellId: cellIdFromH3Index(H3),
        previousSlot: 0,
        movedAt,
      },
    ]
    expect(await sensor()).toMatchObject({
      cellId: NEIGHBOUR,
      previousCellId: H3,
      movedAt: '2026-10-05T12:30:00.000Z',
      voting: true,
      problem: null,
    })
  })

  it('says a key the mirror has never found on chain does not vote', async () => {
    // A row from before the mirror (`T077`): the API would store its readings,
    // and the median would not count them.
    const [row] = rows
    if (row === undefined) throw new Error('no row')
    rows = [{ ...row, mirrored: false }]
    expect(await sensor()).toMatchObject({ cellId: H3, voting: false, problem: 'unregistered' })
  })

  it('says why a registered key does not vote', async () => {
    const [row] = rows
    if (row === undefined) throw new Error('no row')

    rows = [{ ...row, active: false }]
    expect(await sensor()).toMatchObject({ voting: false, problem: 'excluded' })

    rows = [{ ...row, stake: MIN_STAKE - 1n }]
    expect(await sensor()).toMatchObject({ voting: false, problem: 'understaked' })
  })

  it('says nothing votes before there is a pool', async () => {
    minStake = null
    expect(await sensor()).toMatchObject({ minStake: null, voting: false, problem: 'no-pool' })
  })

  it('answers 404 for a key the registry does not have', async () => {
    rows = []
    const response = await get(pubkey)
    expect(response.status).toBe(404)
  })

  it('refuses a key that is not one, and names the field', async () => {
    const response = await get('not-a-key')
    expect(response.status).toBe(400)
    const body = (await response.json()) as FieldsBody
    expect(body.error.details.fields.map((field) => field.field)).toEqual(['pubkey'])
  })
})
