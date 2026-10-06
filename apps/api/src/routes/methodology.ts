import {
  CELL_STATE_DISCRIMINATOR,
  type Connection,
  decodeCellState,
  PROGRAM_ID,
  type PublicKey,
  SENSOR_SLOTS,
} from '@pumpking/anchor-client'
import type { MethodologyStore, StakeRow } from '@pumpking/db'
import {
  COLLUSION_COVER_TIMES,
  capitalExposureLimit,
  cellExposureLimit,
  collusionCost,
  collusionExposureLimit,
  collusionFloor,
  collusionHolds,
  collusionRatio,
  encodeBase58,
  h3IndexFromCellId,
  ReadingKind,
} from '@pumpking/shared'
import { Hono } from 'hono'

/**
 * `GET /v1/methodology` — the published parameters, and the price of
 * collusion against what a cell can be made to pay. `T041`, `FR-054`,
 * `SC-014`.
 *
 * Computed on every request from the pool as it stands on chain, so "checked
 * whenever either parameter changes" is not a promise to remember a check: a
 * new `min_stake` or `cell_exposure_bps` is the next answer. The stake behind
 * each vote comes from the mirror, the same rows the median is taken over; the
 * cells — free slots, what is reserved — from the chain.
 *
 * The verdict of `SC-014` is the **floor**'s: the cheapest cell there can be
 * under these parameters. Every real cell costs at least that
 * (`collusionFloor`), so the floor holding means every cell holds, and the
 * floor failing is a fact about the parameters whatever the cells look like.
 * The cells are listed beside it to show what the real ones cost.
 *
 * **The verdict weighs the price against the capital share** — the exposure
 * limit as a published parameter (`FR-020`) — and not against the limit the
 * program sells under, which since `set_pool_params` (`T041a`) is the lower of
 * that share and half the floor and so passes `SC-014` by construction. Both
 * are on the wire. The verdict says whether the parameters themselves keep a
 * cell's price above what it owes; the program's bound is what holds when they
 * do not, and on a cluster still running a program from before it, nothing
 * does. Judging the share is the answer that is true on both.
 *
 * The page that explains all this is `T047`; this is the number it reads.
 */

/** The pool's parameters this route reads. */
export type MethodologyPool = {
  minStake: bigint
  minVotes: number
  capitalTotal: bigint
  cellExposureBps: number
}

/** A cell as the chain has it. */
export type ChainCell = {
  cellId: bigint
  sensorCount: number
  reserved: bigint
  underInvestigation: boolean
}

export interface CellSource {
  cells(): Promise<ChainCell[]>
}

/** What a price of collusion is, said where the number is. */
export const COLLUSION_MEANING =
  'Stake an attacker has to lock to hold half or more of the votes in a cell, ' +
  'not money it loses: a majority is never an outlier against the median it sets, ' +
  'and an interval the reference disputes still counts. The amounts are mock USDC on devnet.'

export type CollusionPathWire = {
  /** Votes bought from operators already in the cell. */
  bought: number
  /** Votes added as new operators, at the minimum stake. */
  added: number
  /** Decimal base units. */
  cost: string
}

export type CollusionCellWire = {
  /** H3 index in hex. */
  cellId: string
  /** Operators voting here now — `FR-009`. */
  votes: number
  freeSlots: number
  /** Payout committed to live policies here, decimal base units. */
  reserved: string
  underInvestigation: boolean
  /** Null when no interval here can get a value, for anyone. */
  path: CollusionPathWire | null
  /** `cost / capital share`, for reading; null without a path or against a zero share. */
  ratio: number | null
  holds: boolean
}

export type MethodologyWire = {
  /** Null before `initialize_pool`. */
  pool: {
    minStake: string
    minVotes: number
    capitalTotal: string
    cellExposureBps: number
    /** `capital_total · cell_exposure_bps / 10 000` — `FR-020`. */
    capitalExposureLimit: string
    /** Half the collusion floor — `FR-054`. */
    collusionExposureLimit: string
    /** The lower of the two: what the program sells a cell up to (`T041a`). */
    cellExposureLimit: string
    /** Which of the two bounds is the lower — the one that binds. */
    binding: 'capital' | 'collusion'
  } | null
  collusion: {
    meaning: string
    /** `SC-014`: the price has to be this many times the limit. */
    coverTimes: number
    /**
     * The cheapest cell these parameters allow, and the verdict of `SC-014`
     * against the capital share.
     */
    floor: { votes: number; cost: string; ratio: number | null; holds: boolean }
    cells: CollusionCellWire[]
  } | null
}

export type MethodologyRouteOptions = {
  pool: () => Promise<MethodologyPool | null>
  cells: CellSource
  store: MethodologyStore
}

/**
 * The stake behind each vote of each cell: rows that vote (`FR-050`), summed
 * per operator (`FR-009`).
 */
export function voteStakesByCell(
  rows: readonly StakeRow[],
  minStake: bigint,
): Map<bigint, bigint[]> {
  const byCell = new Map<bigint, Map<string, bigint>>()
  for (const row of rows) {
    if (!row.active || row.stake < minStake) continue
    const operators = byCell.get(row.cellId) ?? new Map<string, bigint>()
    operators.set(row.operatorWallet, (operators.get(row.operatorWallet) ?? 0n) + row.stake)
    byCell.set(row.cellId, operators)
  }
  return new Map([...byCell].map(([cellId, operators]) => [cellId, [...operators.values()]]))
}

export function createMethodologyRoute(options: MethodologyRouteOptions): Hono {
  return new Hono().get('/', async (context) => {
    const pool = await options.pool()
    if (pool === null) {
      const wire: MethodologyWire = { pool: null, collusion: null }
      return context.json(wire, 200)
    }

    const [cells, rows] = await Promise.all([
      options.cells.cells(),
      options.store.stakes(ReadingKind.PrecipitationMm),
    ])
    const limit = capitalExposureLimit(pool)
    const collusionLimit = collusionExposureLimit(pool)
    const params = { minStake: pool.minStake, minVotes: pool.minVotes }
    const stakes = voteStakesByCell(rows, pool.minStake)
    const floor = collusionFloor(params)

    const wire: MethodologyWire = {
      pool: {
        minStake: pool.minStake.toString(),
        minVotes: pool.minVotes,
        capitalTotal: pool.capitalTotal.toString(),
        cellExposureBps: pool.cellExposureBps,
        capitalExposureLimit: limit.toString(),
        collusionExposureLimit: collusionLimit.toString(),
        cellExposureLimit: cellExposureLimit(pool).toString(),
        binding: collusionLimit < limit ? 'collusion' : 'capital',
      },
      collusion: {
        meaning: COLLUSION_MEANING,
        coverTimes: Number(COLLUSION_COVER_TIMES),
        floor: {
          votes: Math.max(1, Math.ceil(pool.minVotes / 2)),
          cost: floor.toString(),
          ratio: collusionRatio(floor, limit),
          holds: collusionHolds(floor, limit),
        },
        cells: [...cells]
          .sort((a, b) => (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0))
          .map((cell) => {
            const voteStakes = stakes.get(cell.cellId) ?? []
            const freeSlots = Math.max(0, SENSOR_SLOTS - cell.sensorCount)
            const path = collusionCost({ voteStakes, freeSlots }, params)
            return {
              cellId: h3IndexFromCellId(cell.cellId),
              votes: voteStakes.length,
              freeSlots,
              reserved: cell.reserved.toString(),
              underInvestigation: cell.underInvestigation,
              path:
                path === null
                  ? null
                  : { bought: path.bought, added: path.added, cost: path.cost.toString() },
              ratio: path === null ? null : collusionRatio(path.cost, limit),
              // No path is no value, ever: nothing in the cell can be made to pay.
              holds: path === null || collusionHolds(path.cost, limit),
            }
          }),
      },
    }
    return context.json(wire, 200)
  })
}

/* -------------------------------------------------------------------------- */
/* The cells, from the chain                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `CellSource` backed by a cluster — one `getProgramAccounts` over the
 * `CellState` discriminator, remembered for `ttlMs`.
 *
 * Remembered because the route is public and a scan of every cell is the most
 * expensive read an RPC plan counts; half a minute of staleness in `reserved`
 * changes no verdict a page reader could act on. The pool is not remembered —
 * one `getAccountInfo`, and the parameters are the point of the page.
 */
export function rpcCellSource(
  connection: Connection,
  programId?: PublicKey,
  ttlMs = 30_000,
  now: () => number = Date.now,
): CellSource {
  const program = programId ?? PROGRAM_ID
  let cached: { at: number; cells: Promise<ChainCell[]> } | null = null

  const scan = async (): Promise<ChainCell[]> => {
    const accounts = await connection.getProgramAccounts(program, {
      filters: [{ memcmp: { offset: 0, bytes: encodeBase58(CELL_STATE_DISCRIMINATOR) } }],
    })
    return accounts.map(({ account }) => {
      const cell = decodeCellState(Uint8Array.from(account.data))
      return {
        cellId: BigInt(cell.cellId.toString()),
        sensorCount: cell.sensorCount,
        reserved: BigInt(cell.reserved.toString()),
        underInvestigation: cell.underInvestigation,
      }
    })
  }

  return {
    cells() {
      const at = now()
      if (cached === null || at - cached.at >= ttlMs) {
        const cells = scan()
        cached = { at, cells }
        // A failed scan is not remembered: the next request asks again.
        cells.catch(() => {
          if (cached?.cells === cells) cached = null
        })
      }
      return cached.cells
    },
  }
}
