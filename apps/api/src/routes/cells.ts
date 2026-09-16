import type { DayRow, IntervalStore } from '@pumpking/db'
import { cellIdFromH3Index, H3_CELL_PATTERN } from '@pumpking/shared'
import { Hono } from 'hono'
import { type ZodError, z } from 'zod'

/**
 * `GET /v1/cells/:cellId/days?from&to` — the cell's day journal, as the
 * aggregator wrote it (`FR-047`, `FR-048`).
 *
 * **Postgres, not the chain.** The program keeps a cell's days in a ring of
 * 128 (`day_log`), which is enough for the program's own question — is this
 * policy's window finished, and how long is the run — and not enough for the
 * screen's, which is to draw a **whole** window and keep drawing it after the
 * policy is settled. `cell_days` is kept forever, so a payout is still
 * explainable long after the days behind it have rolled out of the ring.
 *
 * **Days with no row are absent, not filled in.** The store says what it
 * recorded; it does not invent a day it never saw, and this route does not
 * either. A caller that needs the window as a run — the length of a dry spell
 * — asks `spellInWindow`, which is the one place that decides an absent day
 * reads as no coverage. A caller that needs to *draw* the window needs the
 * difference between "recorded as no coverage" and "not reached yet", and
 * filling the gaps here would destroy exactly that difference: this route has
 * no clock and no genesis, so it cannot tell the two apart, and guessing would
 * paint a future day as a break in a farmer's run.
 */

/**
 * Days are addressed by index, not by date: `dayIndex` is what the program
 * counts in, what a policy's window is expressed in (`window_start_day`,
 * `window_end_day`) and what `cell_days` is keyed by. A date would need the
 * pool's genesis timestamp to be meaningful, which is a chain read this route
 * exists to avoid.
 */
const dayIndexSchema = z.int().min(0).max(2_147_483_647)

/**
 * A leap year of one cell's journal.
 *
 * `cell_days` is kept forever, so the span has to be bounded by something;
 * the longest span anything actually asks for is a coverage window, which the
 * program caps at 90 days (`MAX_COVERAGE_DAYS`). A year is four of those, and
 * a request for more history than that is a different question — one that
 * wants paging rather than a bigger ceiling.
 */
export const MAX_DAY_SPAN = 366

const daysQuerySchema = z
  .strictObject({ from: dayIndexSchema, to: dayIndexSchema })
  .refine((range) => range.to >= range.from, {
    path: ['to'],
    message: 'must not be before from',
  })
  .refine((range) => range.to - range.from < MAX_DAY_SPAN, {
    path: ['to'],
    message: `must be within ${MAX_DAY_SPAN} days of from`,
  })

/**
 * A query parameter as a day index, or `NaN` for anything that is not one.
 *
 * Spelled out because `Number('')` is `0`: `?from=&to=3` would otherwise be
 * read as a range starting at the beginning of time rather than as the missing
 * argument it is.
 */
function dayParam(value: string | undefined): number {
  return value === undefined || value.trim() === '' ? Number.NaN : Number(value)
}

/** `FR-041`: which field, and what was wrong with it. */
function fieldErrors(error: ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(query)',
    message: issue.message,
  }))
}

/** A day as the wire carries it. */
export type DayWire = {
  dayIndex: number
  /** 0 no coverage, 1 dry, 2 wet — the same byte the program stores. */
  state: number
  /** Sum of the day's hourly medians in hundredths, null with no coverage. */
  rainfallX100: number | null
  coveredHours: number
  merkleRoot: string | null
  /**
   * `submit_day_record`'s signature, null until it lands. Carried because it
   * is the difference between a day the aggregator believes and a day the
   * chain can be asked about — `FR-048` shows the trace, not just the number.
   */
  txSignature: string | null
}

function toWire(row: DayRow): DayWire {
  return {
    dayIndex: row.dayIndex,
    state: row.state,
    rainfallX100: row.rainfallX100,
    coveredHours: row.coveredHours,
    merkleRoot: row.merkleRoot,
    txSignature: row.txSignature,
  }
}

export type CellsRouteOptions = {
  store: Pick<IntervalStore, 'dayRecords'>
}

export function createCellsRoute(options: CellsRouteOptions): Hono {
  const { store } = options

  return new Hono().get('/:cellId/days', async (context) => {
    const cellIndex = context.req.param('cellId')
    if (!H3_CELL_PATTERN.test(cellIndex)) {
      return context.json(
        {
          error: 'invalid cell',
          fields: [{ field: 'cellId', message: 'must be an H3 cell index in hex' }],
        },
        400,
      )
    }

    const parsed = daysQuerySchema.safeParse({
      // Numbers, not strings: a query is text, and `z.int()` on `"7"` fails
      // with a type message rather than the range one the caller needs.
      from: dayParam(context.req.query('from')),
      to: dayParam(context.req.query('to')),
    })
    if (!parsed.success) {
      return context.json({ error: 'invalid range', fields: fieldErrors(parsed.error) }, 400)
    }
    const { from, to } = parsed.data

    const cellId = cellIdFromH3Index(cellIndex)
    const rows = await store.dayRecords(cellId, from, to)

    // The cell is echoed back in the form it was asked for. A cell with no
    // recorded days is not a 404: it is a cell nobody has measured yet, which
    // is a real and reportable state (`FR-022` refuses to sell cover on it),
    // and telling it apart from a typo is what the pattern check above is for.
    return context.json({ cellId: cellIndex, from, to, days: rows.map(toWire) }, 200)
  })
}
