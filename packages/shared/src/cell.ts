import {
  getHexagonAreaAvg,
  getHexagonEdgeLengthAvg,
  getResolution,
  isValidCell,
  latLngToCell,
  UNITS,
} from 'h3-js'

/**
 * The geographic cell — `FR-006`. A sensor belongs to one, and the cell, not
 * the field, is the unit of consensus, index, policy and exposure limit.
 *
 * Two representations of the same thing live here. `h3-js` speaks hex strings;
 * the program (`CellState.cell_id: u64`) and the database (`cells.id bigint`)
 * speak a 64-bit integer. The conversion lives here, at the edge, so a cell id
 * never has to be parsed twice in two places.
 *
 * Coordinates enter the system exactly once, in `cellFromLatLng`, at sensor
 * registration (`FR-058`). Nothing downstream carries them: a reading names its
 * cell, so a measurement never discloses the field to the metre, and a sensor
 * cannot move itself into someone else's cell by editing a field.
 */

/**
 * Every H3 **cell** index renders as exactly 15 lowercase hex digits starting
 * with `8`: bit 63 is reserved and zero, and bits 59..56 hold mode `1` (cell)
 * with three reserved zeros above it, so the value always sits in
 * `[2^59, 2^60)` and the top hex digit prints as nothing.
 *
 * The pattern is deliberately this tight. It rejects edge and vertex indexes,
 * which are H3 values but not cells, and it stays true across resolutions —
 * `FR-069` makes res 8 an expansion, and a res 8 index matches this too.
 */
export const H3_CELL_PATTERN = /^8[0-9a-f]{14}$/

const MIN_CELL_ID = 0x0800000000000000n
const MAX_CELL_ID = 0x1000000000000000n

/** Parses the hex form h3-js produces into the 64-bit id used everywhere else. */
export function cellIdFromH3Index(index: string): bigint {
  if (!H3_CELL_PATTERN.test(index)) {
    throw new Error(`not an H3 cell index: ${index}`)
  }
  return BigInt(`0x${index}`)
}

/** Renders the 64-bit id back into the hex form h3-js accepts. */
export function h3IndexFromCellId(cellId: bigint): string {
  if (cellId < MIN_CELL_ID || cellId >= MAX_CELL_ID) {
    throw new RangeError(`not an H3 cell id: ${cellId}`)
  }
  return cellId.toString(16)
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The grid level of the first version — `FR-060`. A **default**, not a
 * constant: every function here takes the resolution as a parameter, and a cell
 * already issued reports its own through `cellResolution`.
 *
 * That distinction is what `FR-069` rests on. Moving the network to res 8 does
 * not rewrite the policies sold at res 7 — H3 is hierarchical, each res 7 cell
 * holds exactly seven res 8 children, so the finer level is an expansion and
 * the two coexist. Baking 7 in as a constant is how that turns into a migration.
 */
export const DEFAULT_RESOLUTION = 7

const MIN_RESOLUTION = 0
const MAX_RESOLUTION = 15

function assertResolution(resolution: number): void {
  if (!Number.isInteger(resolution) || resolution < MIN_RESOLUTION || resolution > MAX_RESOLUTION) {
    throw new RangeError(
      `resolution must be an integer in ${MIN_RESOLUTION}..${MAX_RESOLUTION}: ${resolution}`,
    )
  }
}

/** True when the id names a cell H3 actually has, not merely one shaped like it. */
export function isCellId(cellId: bigint): boolean {
  if (cellId < MIN_CELL_ID || cellId >= MAX_CELL_ID) {
    return false
  }
  return isValidCell(cellId.toString(16))
}

/**
 * The grid level a cell belongs to, read out of the id itself.
 *
 * This is what lets a policy be settled at the level it was issued on
 * (`FR-069`): the policy stores a cell id and nothing else about the grid, and
 * the level comes back from the id rather than from whatever the system is
 * configured to sell today.
 */
export function cellResolution(cellId: bigint): number {
  if (!isCellId(cellId)) {
    throw new RangeError(`not an H3 cell id: ${cellId}`)
  }
  return getResolution(cellId.toString(16))
}

/* -------------------------------------------------------------------------- */
/* Coordinates → cell                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The cell a pair of coordinates falls in — the one place coordinates are used
 * (`FR-058`), called once when a sensor registers.
 *
 * Out-of-range coordinates are rejected rather than passed through. H3 accepts
 * them and wraps: `latLngToCell(100, 25, 7)` returns a perfectly valid cell
 * three thousand kilometres from anywhere the caller meant, because 100°N does
 * not exist and the sphere folds it over the pole. A sensor registered from a
 * typo would then vote, honestly and forever, in a cell it is not standing in.
 */
export function cellFromLatLng(lat: number, lng: number, resolution = DEFAULT_RESOLUTION): bigint {
  assertResolution(resolution)
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`latitude must be in -90..90 degrees: ${lat}`)
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError(`longitude must be in -180..180 degrees: ${lng}`)
  }
  return cellIdFromH3Index(latLngToCell(lat, lng, resolution))
}

/* -------------------------------------------------------------------------- */
/* Published size                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How big a cell of a given level is. `FR-060` requires this on the methodology
 * page (`FR-038`) in kilometres: the grid level is the product's main trade-off
 * — a payout is decided by the weather over an area this wide, not over the
 * field — and it is not something to leave for the buyer to find out later.
 */
export type CellSize = {
  resolution: number
  /** Average over the globe; a cell near the equator runs about 10% larger. */
  areaKm2: number
  /** Average hexagon side. */
  edgeKm: number
  /** Widest diagonal — twice the side, the honest answer to "how far across". */
  acrossKm: number
}

/** Reads the figures out of H3 itself, so the page cannot drift from the grid. */
export function cellSize(resolution = DEFAULT_RESOLUTION): CellSize {
  assertResolution(resolution)
  const edgeKm = getHexagonEdgeLengthAvg(resolution, UNITS.km)
  return {
    resolution,
    areaKm2: getHexagonAreaAvg(resolution, UNITS.km2),
    edgeKm,
    acrossKm: edgeKm * 2,
  }
}
