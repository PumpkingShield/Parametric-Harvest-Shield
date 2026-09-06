import { sha256 } from '@noble/hashes/sha2.js'

/**
 * Merkle tree over the material behind a day, and proofs that something was in
 * it — `FR-037`, `SC-010`.
 *
 * One transaction per cell per day carries a root rather than the readings
 * themselves; that is what makes the cost arithmetic work (`SC-007`). The root
 * is published in the event, so anyone holding a reading or an hourly median
 * can build a proof and check for themselves that it went into the day that
 * decided a policy. It is the answer to the open risk in the trust model: the
 * aggregator cannot invent a reading, and a root fixes what it did include.
 *
 * `SC-010` gives a third party ten minutes to redo the whole calculation with
 * nothing but the methodology page and a block explorer, so every choice here
 * is the boring, published one:
 *
 * - **SHA-256**, the hash a block explorer and every standard library already
 *   have.
 * - **Prefixed hashes**, as in RFC 6962: a leaf is `H(0x00 || leaf)` and a node
 *   is `H(0x01 || left || right)`. Without the prefixes an internal node could
 *   be presented as a leaf, and a proof of something that was never in the tree
 *   would verify.
 * - **An odd node moves up unchanged** instead of being paired with a copy of
 *   itself. Duplicating it is what lets two different leaf sets produce the
 *   same root (the flaw Bitcoin carries as CVE-2012-2459), and here that would
 *   mean two different days claiming one proof.
 *
 * Leaf order is the caller's: the tree indexes what it is given and never
 * sorts. Callers hand it something already deterministic — `cellMedian` sorts
 * its votes, readings come ordered by sensor and counter — because the root has
 * to be reproducible from the trace, not merely computable once.
 */

/** SHA-256, so every hash in a proof is this wide. */
export const MERKLE_HASH_BYTES = 32

const LEAF_PREFIX = 0x00
const NODE_PREFIX = 0x01

/**
 * Position of a leaf and the hashes needed to climb from it to the root.
 *
 * `size` is part of the proof, not a convenience: it is what tells the verifier
 * where the tree was odd, and therefore which levels have no sibling to
 * consume. Together with `index` it fixes the shape of the path, so a proof
 * cannot be replayed for a slot the leaf did not occupy.
 *
 * What it does **not** do is authenticate how wide the tree was. Two sizes that
 * leave this particular path unchanged are indistinguishable from the path
 * alone — that is a property of audit paths everywhere, not a gap here. A
 * verifier that needs the width reads it from the day record published with the
 * root, which is the thing the chain actually fixes.
 */
export type MerkleProof = {
  index: number
  size: number
  siblings: Uint8Array[]
}

function hashLeaf(leaf: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(1 + leaf.length)
  buffer[0] = LEAF_PREFIX
  buffer.set(leaf, 1)
  return sha256(buffer)
}

function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(1 + left.length + right.length)
  buffer[0] = NODE_PREFIX
  buffer.set(left, 1)
  buffer.set(right, 1 + left.length)
  return sha256(buffer)
}

/** One level of the tree from the one below it, promoting a trailing odd node. */
function parentLevel(level: readonly Uint8Array[]): Uint8Array[] {
  const next: Uint8Array[] = []
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]
    if (left === undefined) continue
    const right = level[i + 1]
    next.push(right === undefined ? left : hashNode(left, right))
  }
  return next
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Root over the leaves, or null when there are none.
 *
 * Null and not the hash of nothing: an hour that collected no readings has no
 * root, `cell_hours.merkleRoot` is nullable for exactly that, and a real hash
 * sitting there would look like an hour that had been committed to.
 *
 * The 32 bytes go into the database as text and into the event on chain; they
 * are written base58, the same as every other 32-byte value in this system, by
 * the edge that stores them.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array | null {
  if (leaves.length === 0) return null

  let level: Uint8Array[] = leaves.map(hashLeaf)
  while (level.length > 1) {
    level = parentLevel(level)
  }
  return level[0] ?? null
}

/**
 * The proof that the leaf at `index` is in the tree built from `leaves`.
 *
 * Throws on an index the tree does not have — asking for a proof of something
 * that is not there is a programmer error, unlike verifying one, which is an
 * ordinary check of somebody else's claim.
 */
export function merkleProof(leaves: readonly Uint8Array[], index: number): MerkleProof {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`no leaf at index ${index} in a tree of ${leaves.length}`)
  }

  const siblings: Uint8Array[] = []
  let level: Uint8Array[] = leaves.map(hashLeaf)
  let position = index

  while (level.length > 1) {
    const sibling = position % 2 === 1 ? level[position - 1] : level[position + 1]
    // No sibling means this node was the odd one out and moves up untouched.
    if (sibling !== undefined) siblings.push(sibling)
    level = parentLevel(level)
    position >>= 1
  }

  return { index, size: leaves.length, siblings }
}

/**
 * True when `leaf` sits at `proof.index` of a tree of `proof.size` leaves whose
 * root is `root`.
 *
 * Never throws: a proof is somebody else's claim, and a malformed one is a
 * false claim rather than an exception. The sibling count has to come out
 * exactly — a proof carrying one hash more than the shape of the tree calls for
 * is rejected even if the root happens to match, since that is the slack an
 * attacker would work in.
 */
export function verifyMerkleProof(leaf: Uint8Array, proof: MerkleProof, root: Uint8Array): boolean {
  if (!Number.isInteger(proof.index) || !Number.isInteger(proof.size)) return false
  if (proof.size < 1 || proof.index < 0 || proof.index >= proof.size) return false

  let hash = hashLeaf(leaf)
  let position = proof.index
  let width = proof.size
  let used = 0

  while (width > 1) {
    if (position % 2 === 1) {
      const sibling = proof.siblings[used]
      if (sibling === undefined) return false
      used += 1
      hash = hashNode(sibling, hash)
    } else if (position + 1 < width) {
      const sibling = proof.siblings[used]
      if (sibling === undefined) return false
      used += 1
      hash = hashNode(hash, sibling)
    }
    position >>= 1
    width = Math.ceil(width / 2)
  }

  if (used !== proof.siblings.length) return false
  return sameBytes(hash, root)
}
