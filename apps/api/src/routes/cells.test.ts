import type { DayRow } from '@pumpking/db'
import { cellIdFromH3Index, DayState } from '@pumpking/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FieldsBody } from '../errors.ts'
import { createCellsRoute, MAX_DAY_SPAN } from './cells.ts'

const H3 = '871e701b3ffffff'
const CELL_ID = cellIdFromH3Index(H3)
const OTHER_H3 = '872a1072dffffff'

function day(dayIndex: number, state: DayRow['state'], cellId = CELL_ID): DayRow {
  return {
    cellId,
    dayIndex,
    state,
    rainfallX100: state === DayState.NoCoverage ? null : 120,
    coveredHours: state === DayState.NoCoverage ? 0 : 24,
    merkleRoot: 'root',
    txSignature: 'tx',
  }
}

/** The store's own contract: rows in `[from, to]`, ascending, gaps absent. */
class FakeStore {
  rows: DayRow[] = []
  asked: { cellId: bigint; from: number; to: number }[] = []

  dayRecords(cellId: bigint, fromDay: number, toDay: number): Promise<DayRow[]> {
    this.asked.push({ cellId, from: fromDay, to: toDay })
    return Promise.resolve(
      this.rows
        .filter((row) => row.cellId === cellId && row.dayIndex >= fromDay && row.dayIndex <= toDay)
        .sort((a, b) => a.dayIndex - b.dayIndex),
    )
  }
}

let store: FakeStore

beforeEach(() => {
  store = new FakeStore()
})

async function get(path: string): Promise<Response> {
  return await createCellsRoute({ store }).request(path)
}

describe('GET /v1/cells/:cellId/days', () => {
  it('answers with the recorded days of the range, ascending', async () => {
    store.rows = [day(2, DayState.Wet), day(0, DayState.Dry), day(1, DayState.Dry)]

    const response = await get(`/${H3}/days?from=0&to=2`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.cellId).toBe(H3)
    expect(body.from).toBe(0)
    expect(body.to).toBe(2)
    expect(body.days).toEqual([
      {
        dayIndex: 0,
        state: DayState.Dry,
        rainfallX100: 120,
        coveredHours: 24,
        merkleRoot: 'root',
        txSignature: 'tx',
      },
      {
        dayIndex: 1,
        state: DayState.Dry,
        rainfallX100: 120,
        coveredHours: 24,
        merkleRoot: 'root',
        txSignature: 'tx',
      },
      {
        dayIndex: 2,
        state: DayState.Wet,
        rainfallX100: 120,
        coveredHours: 24,
        merkleRoot: 'root',
        txSignature: 'tx',
      },
    ])
  })

  it('asks the store for the cell the path named', async () => {
    await get(`/${H3}/days?from=10&to=20`)
    expect(store.asked).toEqual([{ cellId: CELL_ID, from: 10, to: 20 }])
  })

  /**
   * The difference this route must not destroy: a day recorded as no coverage
   * is an answer, a day with no row is not. Filling the gap here would paint a
   * day that has not been reached yet as a break in somebody's run.
   */
  it('leaves a day with no row out rather than filling it in', async () => {
    store.rows = [day(0, DayState.Dry), day(2, DayState.NoCoverage)]

    const body = (await (await get(`/${H3}/days?from=0&to=3`)).json()) as {
      days: { dayIndex: number; state: number }[]
    }
    expect(body.days.map((one) => one.dayIndex)).toEqual([0, 2])
    expect(body.days[1]?.state).toBe(DayState.NoCoverage)
  })

  it('does not reach into another cell', async () => {
    store.rows = [day(0, DayState.Dry, cellIdFromH3Index(OTHER_H3))]

    const body = (await (await get(`/${H3}/days?from=0&to=3`)).json()) as { days: unknown[] }
    expect(body.days).toEqual([])
  })

  /**
   * A cell nobody has measured yet is a real state — `FR-022` refuses to sell
   * cover on it — and not a missing resource.
   */
  it('answers with an empty journal rather than 404', async () => {
    const response = await get(`/${H3}/days?from=0&to=3`)
    expect(response.status).toBe(200)
  })

  it('covers a single day when both ends are the same', async () => {
    store.rows = [day(7, DayState.Dry)]

    const body = (await (await get(`/${H3}/days?from=7&to=7`)).json()) as { days: unknown[] }
    expect(body.days).toHaveLength(1)
  })
})

describe('GET /v1/cells/:cellId/days — refusals', () => {
  it('refuses a cell id that is not an H3 index', async () => {
    const response = await get('/not-a-cell/days?from=0&to=1')
    expect(response.status).toBe(400)
    const body = (await response.json()) as FieldsBody
    expect(body.error.details.fields[0]?.field).toBe('cellId')
    expect(store.asked).toEqual([])
  })

  it('refuses a range that is missing', async () => {
    const response = await get(`/${H3}/days`)
    expect(response.status).toBe(400)
    const body = (await response.json()) as FieldsBody
    expect(body.error.details.fields.map((one) => one.field)).toEqual(['from', 'to'])
  })

  it('refuses a day index that is not a whole number', async () => {
    const response = await get(`/${H3}/days?from=0.5&to=3`)
    expect(response.status).toBe(400)
    const body = (await response.json()) as FieldsBody
    expect(body.error.details.fields[0]?.field).toBe('from')
  })

  it('refuses a negative day index', async () => {
    const response = await get(`/${H3}/days?from=-1&to=3`)
    expect(response.status).toBe(400)
  })

  it('refuses a range that runs backwards', async () => {
    const response = await get(`/${H3}/days?from=5&to=4`)
    expect(response.status).toBe(400)
    const body = (await response.json()) as FieldsBody
    expect(body.error.details.fields[0]).toEqual({ field: 'to', message: 'must not be before from' })
  })

  it('refuses a span longer than a year', async () => {
    const response = await get(`/${H3}/days?from=0&to=${MAX_DAY_SPAN}`)
    expect(response.status).toBe(400)
    expect(store.asked).toEqual([])
  })

  it('allows the longest span it does accept', async () => {
    const response = await get(`/${H3}/days?from=0&to=${MAX_DAY_SPAN - 1}`)
    expect(response.status).toBe(200)
  })
})
