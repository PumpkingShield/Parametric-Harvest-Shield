import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type MerkleProof, merkleProof, merkleRoot, verifyMerkleProof } from './merkle.ts'

type MerkleFixture = {
  cases: {
    name: string
    leaves: string[]
    rootHex: string
    proofs: { index: number; size: number; siblingsHex: string[] }[]
  }[]
}

const fixtures = JSON.parse(
  readFileSync(new URL('../../../fixtures/merkle-cases.json', import.meta.url), 'utf8'),
) as MerkleFixture

const encoder = new TextEncoder()
const leavesOf = (names: string[]) => names.map((name) => encoder.encode(name))
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const bytes = (hexed: string) => Uint8Array.from(Buffer.from(hexed, 'hex'))

const [firstCase] = fixtures.cases
if (firstCase === undefined) throw new Error('fixtures/merkle-cases.json has no cases')

describe('merkleRoot', () => {
  for (const testCase of fixtures.cases) {
    it(`matches the golden root: ${testCase.name}`, () => {
      const root = merkleRoot(leavesOf(testCase.leaves))
      expect(root).not.toBeNull()
      expect(root && hex(root)).toBe(testCase.rootHex)
    })
  }

  it('has no root for no leaves', () => {
    // Null and not the hash of nothing: an hour that collected no readings has
    // not been committed to, and a real hash there would say it had.
    expect(merkleRoot([])).toBeNull()
  })

  it('depends on the order of the leaves', () => {
    const a = encoder.encode('a')
    const b = encoder.encode('b')
    expect(hex(merkleRoot([a, b]) ?? new Uint8Array())).not.toBe(
      hex(merkleRoot([b, a]) ?? new Uint8Array()),
    )
  })

  it('does not give an odd tree the root of its padded self — CVE-2012-2459', () => {
    // Pairing the odd node with a copy of itself is what lets two different
    // leaf sets share a root, and a shared root is two days claiming one proof.
    const [a, b, c] = [encoder.encode('a'), encoder.encode('b'), encoder.encode('c')]
    const odd = merkleRoot([a, b, c])
    const padded = merkleRoot([a, b, c, c])
    expect(odd).not.toBeNull()
    expect(padded).not.toBeNull()
    expect(hex(odd ?? new Uint8Array())).not.toBe(hex(padded ?? new Uint8Array()))
  })
})

describe('merkleProof', () => {
  for (const testCase of fixtures.cases) {
    for (const expected of testCase.proofs) {
      it(`matches the golden proof for leaf ${expected.index} of ${testCase.name}`, () => {
        const proof = merkleProof(leavesOf(testCase.leaves), expected.index)
        expect(proof.index).toBe(expected.index)
        expect(proof.size).toBe(expected.size)
        expect(proof.siblings.map(hex)).toEqual(expected.siblingsHex)
      })
    }
  }

  it('refuses to prove a leaf the tree does not have', () => {
    const leaves = leavesOf(firstCase.leaves)
    expect(() => merkleProof(leaves, leaves.length)).toThrow(RangeError)
    expect(() => merkleProof(leaves, -1)).toThrow(RangeError)
    expect(() => merkleProof(leaves, 0.5)).toThrow(RangeError)
    expect(() => merkleProof([], 0)).toThrow(RangeError)
  })
})

describe('verifyMerkleProof', () => {
  for (const testCase of fixtures.cases) {
    it(`accepts every leaf of ${testCase.name}`, () => {
      const leaves = leavesOf(testCase.leaves)
      const root = bytes(testCase.rootHex)
      for (const [index, leaf] of leaves.entries()) {
        expect(verifyMerkleProof(leaf, merkleProof(leaves, index), root)).toBe(true)
      }
    })
  }

  const wide = fixtures.cases.find((testCase) => testCase.leaves.length === 7)
  if (wide === undefined) throw new Error('the 7-leaf case is what the tampering tests need')

  const leaves = leavesOf(wide.leaves)
  const root = bytes(wide.rootHex)
  const proofFor = (index: number) => merkleProof(leaves, index)
  const leafAt = (index: number) => {
    const leaf = leaves[index]
    if (leaf === undefined) throw new Error(`no leaf at ${index}`)
    return leaf
  }

  it('rejects a leaf that was never in the tree', () => {
    expect(verifyMerkleProof(encoder.encode('leaf-99'), proofFor(3), root)).toBe(false)
  })

  it('rejects a proof against another root', () => {
    const other = merkleRoot(leavesOf(['leaf-0', 'leaf-1']))
    expect(other).not.toBeNull()
    expect(verifyMerkleProof(leafAt(3), proofFor(3), other ?? new Uint8Array())).toBe(false)
  })

  it('rejects a proof replayed at another position', () => {
    // The index and the size are part of the claim, so a valid path cannot be
    // reused to say that the same leaf sat somewhere else in the tree.
    const moved: MerkleProof = { ...proofFor(3), index: 2 }
    expect(verifyMerkleProof(leafAt(3), moved, root)).toBe(false)
  })

  it('rejects a claimed size that changes the shape of the path', () => {
    // Leaf 6 is the odd one out of seven and climbs one level unpaired, so a
    // proof of it carries two siblings. Claiming eight leaves asks for three.
    const resized: MerkleProof = { ...proofFor(6), size: 8 }
    expect(verifyMerkleProof(leafAt(6), resized, root)).toBe(false)
  })

  it('does not pretend the path authenticates the width of the tree', () => {
    // Honest limit, not an oversight. Leaf 3 climbs 3 -> 1 -> 0 taking a
    // sibling at every level, which is the same shape in a tree of seven and
    // one of eight; the promotion that distinguishes them happens over at leaf
    // 6, off this path. An audit path proves membership under a root and
    // nothing about how wide the tree was. What fixes the width is the record
    // published with the root on chain, which is where a verifier reads it.
    const resized: MerkleProof = { ...proofFor(3), size: 8 }
    expect(verifyMerkleProof(leafAt(3), resized, root)).toBe(true)
  })

  it('rejects a proof with a sibling missing', () => {
    const proof = proofFor(3)
    const short: MerkleProof = { ...proof, siblings: proof.siblings.slice(0, -1) }
    expect(verifyMerkleProof(leafAt(3), short, root)).toBe(false)
  })

  it('rejects a proof with a sibling too many', () => {
    // The count has to come out exactly. Slack at the end of the list is where
    // an attacker works, even when the root happens to match.
    const proof = proofFor(3)
    const long: MerkleProof = {
      ...proof,
      siblings: [...proof.siblings, new Uint8Array(32)],
    }
    expect(verifyMerkleProof(leafAt(3), long, root)).toBe(false)
  })

  it('rejects a proof with a sibling altered', () => {
    const proof = proofFor(3)
    const first = proof.siblings[0]
    if (first === undefined) throw new Error('the proof should have siblings')
    const flipped = Uint8Array.from(first)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(
      verifyMerkleProof(
        leafAt(3),
        { ...proof, siblings: [flipped, ...proof.siblings.slice(1)] },
        root,
      ),
    ).toBe(false)
  })

  it('rejects an index outside the tree', () => {
    expect(verifyMerkleProof(leafAt(0), { index: 7, size: 7, siblings: [] }, root)).toBe(false)
    expect(verifyMerkleProof(leafAt(0), { index: -1, size: 7, siblings: [] }, root)).toBe(false)
    expect(verifyMerkleProof(leafAt(0), { index: 0, size: 0, siblings: [] }, root)).toBe(false)
    expect(verifyMerkleProof(leafAt(0), { index: 0.5, size: 7, siblings: [] }, root)).toBe(false)
  })

  it('does not let an internal node pass as a leaf', () => {
    // The reason leaves and nodes are hashed under different prefixes. Without
    // them the two children of the root, concatenated, would be a leaf whose
    // hash is the root itself — a proof of something never in the tree.
    const pair = leavesOf(['leaf-0', 'leaf-1'])
    const pairRoot = merkleRoot(pair)
    expect(pairRoot).not.toBeNull()

    const forged = new Uint8Array(64)
    const zero = merkleProof(pair, 0)
    const sibling = zero.siblings[0]
    if (sibling === undefined) throw new Error('a two-leaf proof has one sibling')
    forged.set(sibling, 32)

    expect(
      verifyMerkleProof(forged, { index: 0, size: 1, siblings: [] }, pairRoot ?? new Uint8Array()),
    ).toBe(false)
  })
})
