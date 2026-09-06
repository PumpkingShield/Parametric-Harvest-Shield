import { base58 } from '@scure/base'

/**
 * Base58 in the Bitcoin/Solana alphabet — the form every key, signature and
 * account address in this system is written in.
 *
 * One implementation, not two: the leading-zero rule (each leading zero byte
 * becomes a literal `1`, outside the big-integer arithmetic) is exactly where
 * hand-rolled base58 quietly loses a byte, and a key that decoded to 31 bytes
 * would fail verification for a reason nobody would ever find.
 */
export function encodeBase58(bytes: Uint8Array): string {
  return base58.encode(bytes)
}

/**
 * Decodes base58 and checks the length in one step.
 *
 * Returns `null` rather than throwing: every caller is parsing input from the
 * network, where a malformed key is an ordinary rejection (`FR-002`) and not an
 * exceptional condition. Every field this decodes is fixed width, so a length
 * that does not match is as wrong as a bad character.
 */
export function decodeBase58(text: string, expectedLength: number): Uint8Array | null {
  let bytes: Uint8Array
  try {
    bytes = base58.decode(text)
  } catch {
    return null
  }
  return bytes.length === expectedLength ? bytes : null
}
