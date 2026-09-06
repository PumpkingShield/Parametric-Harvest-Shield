import { getPublicKeyAsync, signAsync, verifyAsync } from '@noble/ed25519'
import { decodeBase58, encodeBase58 } from './base58.ts'
import {
  canonicalReadingBytes,
  READING_SIGNATURE_BYTES,
  type Reading,
  SENSOR_KEY_BYTES,
  type SignedReading,
} from './reading.ts'

/**
 * Ed25519 over the canonical reading bytes — `FR-002`.
 *
 * What this proves: the holder of the sensor's private key produced exactly
 * these values. What it does not prove, and what the caller still has to check
 * before storing a measurement:
 *
 * - that the key is **registered** (`FR-002`) — a lookup in `sensors`, and the
 *   registry is what binds a key to an operator and a cell;
 * - that the **counter** has not been used before (`FR-003`) — the
 *   `readings_sensor_counter_uq` constraint;
 * - that the reading arrived inside the window (`FR-004`).
 *
 * The async API is the whole surface here. `@noble/ed25519` reaches SHA-512
 * through WebCrypto on that path, which Node 24 and every target browser
 * provide; the synchronous path would need a hash wired in by hand, and a
 * global left unset in one entry point would turn every verification into a
 * thrown error rather than a rejected reading.
 */

/**
 * True when the signature is a valid ed25519 signature by `reading.sensor` over
 * the canonical bytes of the reading.
 *
 * Never throws. Every failure mode — a key that is not base58, a signature of
 * the wrong length, a point off the curve, a field out of range — is one thing
 * from the caller's side: this reading is not signed by the key it names, and
 * it is rejected (`FR-002`).
 */
export async function verifyReadingSignature(reading: SignedReading): Promise<boolean> {
  const publicKey = decodeBase58(reading.sensor, SENSOR_KEY_BYTES)
  if (publicKey === null) return false

  const signature = decodeBase58(reading.signature, READING_SIGNATURE_BYTES)
  if (signature === null) return false

  try {
    return await verifyAsync(signature, canonicalReadingBytes(reading), publicKey)
  } catch {
    return false
  }
}

/**
 * Signs a reading with a sensor's 32-byte secret seed and returns the base58
 * signature.
 *
 * This is what the browser sensor (`FR-005`) calls: the key pair is generated
 * on the operator's device and the secret never leaves it, so signing has to be
 * available client-side, from the same module that defines the bytes. Scenario
 * runs (`FR-042`) and the tests use it for the same reason — a second
 * implementation of the signing side is a second definition of the format.
 */
export async function signReading(reading: Reading, secretKey: Uint8Array): Promise<string> {
  const signature = await signAsync(canonicalReadingBytes(reading), secretKey)
  return encodeBase58(signature)
}

/** Base58 public key for a 32-byte secret seed — the identity of a sensor. */
export async function sensorPublicKey(secretKey: Uint8Array): Promise<string> {
  return encodeBase58(await getPublicKeyAsync(secretKey))
}
