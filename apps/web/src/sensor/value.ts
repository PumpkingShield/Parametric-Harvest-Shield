/**
 * What the operator types, as the integer the reading carries — `FR-005`.
 *
 * The phone measures nothing itself: the operator reads a rain gauge and types
 * the millimetres of the past hour, and the phone signs them. The value goes
 * into the reading as hundredths of a millimetre (`valueX100`), so the text is
 * parsed digit by digit into an integer and never passes through a float —
 * `parseFloat('0.29') * 100` is `28.999999999999996`, and the consensus has no
 * floating point to round it back (`CLAUDE.md`).
 *
 * A third decimal is refused, not rounded. A gauge does not read to a
 * hundredth of a millimetre, so one is a typo, and a typo quietly rounded is a
 * signed claim the operator did not make.
 */

export type ParsedValue = { ok: true; valueX100: number } | { ok: false; message: string }

/** Below `i32::MAX / 100` with room to spare; no gauge holds ten metres. */
const MAX_WHOLE_DIGITS = 7

const MILLIMETRES = new RegExp(`^(\\d{1,${MAX_WHOLE_DIGITS}})(?:[.,](\\d{1,2}))?$`)

export function parseMillimetres(text: string): ParsedValue {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { ok: false, message: 'Enter the rain of the past hour, in millimetres.' }
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, message: 'Rain cannot be negative. A dry hour is 0.' }
  }
  const match = MILLIMETRES.exec(trimmed)
  if (match === null) {
    return /^\d+[.,]\d{3,}$/.test(trimmed)
      ? { ok: false, message: 'Two decimals at most — a gauge does not read finer.' }
      : { ok: false, message: 'Millimetres as a number, like 0, 2.5 or 12.' }
  }
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').padEnd(2, '0')
  return { ok: true, valueX100: Number(whole) * 100 + Number(fraction) }
}

/** `valueX100` back to the millimetres the operator typed, for the receipt. */
export function formatMillimetres(valueX100: number): string {
  const whole = Math.trunc(valueX100 / 100)
  const fraction = valueX100 % 100
  return fraction === 0 ? `${whole}` : `${whole}.${String(fraction).padStart(2, '0')}`
}
