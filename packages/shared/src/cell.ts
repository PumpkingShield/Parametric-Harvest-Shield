/**
 * The two representations of an H3 cell and the conversion between them.
 *
 * `h3-js` speaks hex strings; the program (`CellState.cell_id: u64`) and the
 * database (`cells.id bigint`) speak a 64-bit integer. The conversion lives
 * here, at the edge, so a cell id never has to be parsed twice in two places.
 *
 * T012 adds coordinates → cell and the resolution parameter (`FR-060`) to this
 * same file; the identifier conversion is already needed by `reading.ts`.
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
