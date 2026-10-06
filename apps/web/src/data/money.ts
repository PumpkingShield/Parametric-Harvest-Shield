/**
 * Sums of the pool's asset, as the screens write them — `FR-056`.
 *
 * The asset is a mock token on devnet, and every sum says so by its name: a
 * demo in which a mock balance reads as money is false testimony whatever the
 * accompanying material says.
 */

/** What the asset is called next to every sum. */
export const ASSET = 'mock USDC'

/**
 * Base units as a sum, every digit kept — for rewards, which are fractions of
 * a cent a day, and shown as `0.00` by a formatter that stops at hundredths
 * would read as nothing earned. Trailing zeros past the hundredths dropped.
 */
export function formatExact(baseUnits: bigint | string, decimals: number): string {
  const units = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits)
  const scale = 10n ** BigInt(decimals)
  const whole = units / scale
  const fraction = String(units % scale)
    .padStart(decimals, '0')
    .replace(/0+$/, '')
    .padEnd(Math.min(2, decimals), '0')
  return fraction === '' ? `${whole}` : `${whole}.${fraction}`
}
