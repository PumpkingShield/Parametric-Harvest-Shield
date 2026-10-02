/**
 * Outliers and a sensor's reputation — `FR-011`, `FR-012`.
 *
 * The window is the one number here the program also knows:
 * `OUTLIER_WINDOW_DAYS` in `programs/pumpking/src/state.rs`, where the pool
 * refuses any `unstake_delay_days` that does not outlast it (`FR-053`). The
 * client's test checks this twin against the value the program put in its IDL.
 */

/**
 * Days over which a sensor's outliers are counted before it is excluded.
 *
 * A constant rather than a pool parameter, on the chain as here: a window the
 * authority could shorten in the middle of somebody's thaw would let that stake
 * leave before the count that should have burnt it was finished.
 */
export const OUTLIER_WINDOW_DAYS = 14
