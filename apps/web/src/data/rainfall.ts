import { classifyDay, type DayClassification, DayState } from '@pumpking/shared/day'

/**
 * The mock windows the M0 prototype draws.
 *
 * Numbers are hundredths of a millimetre, like everywhere else in the project:
 * the consensus has no floating point, and a screen that teaches `2.0` while
 * the chain compares `200` teaches the wrong rule at the boundary. The
 * classification and the run length are **not** computed here — `classifyDay`
 * and `drySpell` come from `@pumpking/shared`, so the strip and the payout
 * answer the same question with the same code. Only the *position* of the run
 * is local, because the bracket has to be drawn somewhere and the index does
 * not care where.
 *
 * Both arrive by **subpath**, not from the barrel: the barrel reaches `cell.ts`
 * and drags `h3-js` — 550 kB of asm.js — into a page that never asks where a
 * cell is. `day.ts` imports nothing at all, and `index-math.ts` imports only
 * `day.ts`.
 *
 * Every number below is synthetic. Nothing here reaches a chain.
 */

export type SquareState = 'dry' | 'wet' | 'none' | 'future' | 'closed' | 'filled'

export interface StripCell {
  /** the one line printed under the strip when this square is tapped */
  detail: string
  state: SquareState
  topLabel?: string | undefined
}

export interface Bracket {
  start: number
  end: number
  length: number
  label: string
}

export interface StripWindow {
  cells: StripCell[]
  /** the elapsed days only, in the form `drySpell` reads */
  days: DayClassification[]
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * A day of the prototype arrives already summed, so it is handed to
 * `classifyDay` as a single interval: a value means the cell was measured,
 * `null` means too few sensors reported and the day has no value at all.
 */
const DAY_PARAMS = { dryThresholdX100: 200, minimumCoverageX100: 100 }

const SENSORS_REGISTERED = 5
const SENSORS_VOTING = 4

const SQUARE_BY_DAY: Record<DayClassification, SquareState> = {
  [DayState.NoCoverage]: 'none',
  [DayState.Dry]: 'dry',
  [DayState.Wet]: 'wet',
}

function dayLabel(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`
}

function millimetres(rainfallX100: number): string {
  return (rainfallX100 / 100).toFixed(1)
}

interface WindowInput {
  startYear: number
  startMonthIndex: number
  startDay: number
  totalDays: number
  /** one entry per elapsed day, hundredths of a mm; null means no coverage */
  readings: ReadonlyArray<number | null>
  /** what the days of the window that carry no reading are */
  tailState: 'future' | 'closed'
  tailNote: string
}

export function buildWindow(input: WindowInput): StripWindow {
  const cells: StripCell[] = []
  const days: DayClassification[] = []

  for (let i = 0; i < input.totalDays; i += 1) {
    const date = new Date(Date.UTC(input.startYear, input.startMonthIndex, input.startDay + i))
    const label = dayLabel(date)
    const topLabel =
      i === 0 || date.getUTCDate() === 1 ? MONTHS_SHORT[date.getUTCMonth()] : undefined

    if (i >= input.readings.length) {
      cells.push({ state: input.tailState, detail: `${label} — ${input.tailNote}`, topLabel })
      continue
    }

    const value = input.readings[i] ?? null
    const day = classifyDay([value], DAY_PARAMS)
    days.push(day.state)

    if (day.rainfallX100 === null) {
      cells.push({
        state: SQUARE_BY_DAY[day.state],
        detail: `${label} — no reading — 1 of ${SENSORS_REGISTERED} sensors, no coverage`,
        topLabel,
      })
      continue
    }

    cells.push({
      state: SQUARE_BY_DAY[day.state],
      detail: `${label} — ${millimetres(day.rainfallX100)} mm — ${SENSORS_VOTING} of ${SENSORS_REGISTERED} sensors`,
      topLabel,
    })
  }

  return { cells, days }
}

/**
 * Where the longest dry run sits, so the bracket can be drawn under it.
 *
 * The **length** it reports is the index itself, and `drySpell` in
 * `@pumpking/shared` is the only thing allowed to define that. This function
 * is therefore checked against it in `rainfall.test.ts`, and if the two ever
 * disagree the screen is drawing a bracket the chain would not pay on.
 */
export function longestDryRun(days: ReadonlyArray<DayClassification>): Bracket | undefined {
  let bestStart = -1
  let bestLength = 0
  let currentStart = -1
  let currentLength = 0

  for (let i = 0; i < days.length; i += 1) {
    if (days[i] === DayState.Dry) {
      if (currentLength === 0) currentStart = i
      currentLength += 1
      if (currentLength > bestLength) {
        bestLength = currentLength
        bestStart = currentStart
      }
    } else {
      currentLength = 0
    }
  }

  if (bestLength === 0 || bestStart < 0) return undefined
  return {
    start: bestStart,
    end: bestStart + bestLength - 1,
    length: bestLength,
    label: `${bestLength} days`,
  }
}

/* ---------------------------------------------------------------- */
/* Screen 1 — the farmer's open policy, 1 Aug – 30 Sep 2026          */
/* ---------------------------------------------------------------- */

/** 1–11 Aug day by day, then the 18-day run of 12–29 Aug that is still going. */
const POLICY_READINGS: ReadonlyArray<number | null> = [
  0,
  20,
  160,
  0,
  null,
  null,
  890,
  40,
  0,
  170,
  460,
  0,
  0,
  30,
  0,
  110,
  0,
  0,
  60,
  0,
  0,
  0,
  140,
  20,
  0,
  0,
  0,
  90,
  0,
]

export const POLICY_WINDOW: StripWindow = buildWindow({
  startYear: 2026,
  startMonthIndex: 7,
  startDay: 1,
  totalDays: 61,
  readings: POLICY_READINGS,
  tailState: 'future',
  tailNote: 'not yet reached',
})

export const POLICY_BRACKET = longestDryRun(POLICY_WINDOW.days)

/* ---------------------------------------------------------------- */
/* Screen 3 — the closed policy that paid, 15 May – 12 Aug 2026      */
/* ---------------------------------------------------------------- */

/** 15 May – 23 Jun: wet and dry mixed, and one day nobody measured on 2 June. */
const PAID_BEFORE_RUN: ReadonlyArray<number | null> = [
  640,
  0,
  20,
  1210,
  340,
  0,
  0,
  190,
  0,
  520,
  0,
  0,
  0,
  260,
  0,
  80,
  930,
  0,
  null,
  0,
  40,
  310,
  0,
  0,
  0,
  120,
  770,
  0,
  0,
  50,
  0,
  490,
  0,
  0,
  180,
  0,
  240,
  0,
  30,
  560,
]

/** 24 Jun – 14 Jul: the twenty-one dry days the policy was settled on. */
const PAID_RUN: ReadonlyArray<number> = [
  0, 0, 70, 0, 0, 130, 0, 0, 40, 0, 0, 0, 180, 0, 20, 0, 0, 90, 0, 0, 0,
]

export const PAID_WINDOW: StripWindow = buildWindow({
  startYear: 2026,
  startMonthIndex: 4,
  startDay: 15,
  totalDays: 90,
  readings: [...PAID_BEFORE_RUN, ...PAID_RUN],
  tailState: 'closed',
  tailNote: 'policy closed, already paid',
})

export const PAID_BRACKET = longestDryRun(PAID_WINDOW.days)

/* ---------------------------------------------------------------- */
/* Screen 2 — one sensor's twenty-four hours, 29 Aug 2026            */
/* ---------------------------------------------------------------- */

const REJECTED_HOUR = 14

export const SENSOR_HOURS: StripCell[] = Array.from({ length: 24 }, (_unused, hour) => {
  const stamp = `${String(hour).padStart(2, '0')}:00`
  if (hour === REJECTED_HOUR) {
    return {
      state: 'none' as const,
      detail: `${stamp} — 11.2 mm — rejected, cell median was 0.0 mm`,
    }
  }
  return {
    state: 'filled' as const,
    detail: `${stamp} — 0.0 mm — accepted, matched the cell median`,
  }
})

export const CELL_ID = '872a1072dffffff'
