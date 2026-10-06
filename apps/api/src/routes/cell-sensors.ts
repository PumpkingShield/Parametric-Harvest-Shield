import type { OperatorStore } from '@pumpking/db'
import {
  cellIdFromH3Index,
  H3_CELL_PATTERN,
  OUTLIER_WINDOW_DAYS,
  ReadingKind,
} from '@pumpking/shared'
import { Hono } from 'hono'
import { apiError } from '../errors.ts'
import { dayIndexOf, type PoolClock } from './activity.ts'
import type { SensorStatusProblem } from './sensors.ts'

/**
 * `GET /v1/cells/:cellId/sensors` — who measures a cell, and who of them
 * counts. `T040`, `FR-007`, `FR-050`.
 *
 * The registry is public on chain (`FR-007`); this is the mirror of it for one
 * cell, with each sensor's record over the window an exclusion is decided on
 * (`OUTLIER_WINDOW_DAYS`). It is what makes the price of collusion visible on
 * the operator screen: a sensor without the stake is listed, publishing, and
 * marked as not counted.
 *
 * The sensors whose **own** cell this is. One that moved away still holds a
 * slot here for its record (`FR-059`) but no longer votes here, and listing it
 * among the cell's sensors would say otherwise.
 */

export type CellSensorWire = {
  pubkey: string
  operator: string
  slot: number
  /** Decimal base units. */
  stake: string
  voting: boolean
  problem: Exclude<SensorStatusProblem, 'unregistered'> | null
  /** Intervals judged and judged outliers over the window, in any cell. */
  judged: number
  outliers: number
}

export type CellSensorsWire = {
  cellId: string
  minStake: string | null
  windowDays: number
  sensors: CellSensorWire[]
}

export type CellSensorsRouteOptions = {
  store: Pick<OperatorStore, 'cellSensors'>
  minStake: () => Promise<bigint | null>
  clock: () => Promise<PoolClock | null>
  now?: () => Date
}

export function createCellSensorsRoute(options: CellSensorsRouteOptions): Hono {
  const now = options.now ?? (() => new Date())

  return new Hono().get('/:cellId/sensors', async (context) => {
    const cellIndex = context.req.param('cellId')
    if (!H3_CELL_PATTERN.test(cellIndex)) {
      return apiError(context, 400, 'invalid cell', {
        fields: [{ field: 'cellId', message: 'must be an H3 cell index in hex' }],
      })
    }

    const [minStake, clock] = await Promise.all([options.minStake(), options.clock()])
    const today = clock === null ? null : dayIndexOf(clock, now())
    const toDay = today ?? 0
    const fromDay = Math.max(0, toDay - OUTLIER_WINDOW_DAYS + 1)
    const rows = await options.store.cellSensors(
      cellIdFromH3Index(cellIndex),
      ReadingKind.PrecipitationMm,
      fromDay,
      toDay,
    )

    const wire: CellSensorsWire = {
      cellId: cellIndex,
      minStake: minStake === null ? null : minStake.toString(),
      windowDays: OUTLIER_WINDOW_DAYS,
      sensors: rows.map((row) => {
        // The rows are mirrored and in this cell, so of `statusProblem`'s
        // reasons only these three can apply.
        const problem =
          minStake === null
            ? ('no-pool' as const)
            : !row.active
              ? ('excluded' as const)
              : row.stake < minStake
                ? ('understaked' as const)
                : null
        return {
          pubkey: row.pubkey,
          operator: row.operatorWallet,
          slot: row.slotInCell,
          stake: row.stake.toString(),
          voting: problem === null,
          problem,
          judged: row.judged,
          outliers: row.outliers,
        }
      }),
    }
    return context.json(wire, 200)
  })
}
