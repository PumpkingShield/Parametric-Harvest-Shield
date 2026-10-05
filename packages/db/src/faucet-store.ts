import { and, count, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { faucetGrants } from './schema.ts'

/**
 * The devnet faucet's ledger — `T038a`.
 *
 * Three operations around one transaction: take the key's row, send, then
 * either record the signature or give the row back. The row is the lock, so it
 * is taken first: a second request for the same key, arriving while the first
 * is still on its way to the cluster, finds it taken and is refused rather than
 * paid twice.
 */

export type FaucetClaim =
  | { claimed: true }
  /** Somebody already holds the key's grant; `signature` is null while it is in flight. */
  | { claimed: false; signature: string | null }

export interface FaucetStore {
  /** Grants since `since` — all of them, and those from one caller. */
  countsSince(since: Date, addressHash: string): Promise<{ total: number; fromAddress: number }>
  /**
   * Takes the key's row. An unsettled row older than `staleBefore` is a grant
   * whose process died between sending and recording — it is taken over
   * rather than left to lock the key out for good. If that transaction did
   * land, the key is paid twice: on devnet, in a mock asset, a smaller harm
   * than an operator who can never register.
   */
  claim(pubkey: string, addressHash: string, at: Date, staleBefore: Date): Promise<FaucetClaim>
  settle(pubkey: string, signature: string): Promise<void>
  /** The transaction failed: the key may ask again. */
  release(pubkey: string): Promise<void>
}

export function pgFaucetStore(db: PostgresJsDatabase<Record<string, never>>): FaucetStore {
  return {
    async countsSince(since, addressHash) {
      const [row] = await db
        .select({
          total: count(),
          fromAddress:
            sql<number>`count(*) filter (where ${faucetGrants.addressHash} = ${addressHash})`.mapWith(
              Number,
            ),
        })
        .from(faucetGrants)
        .where(gte(faucetGrants.grantedAt, since))
      return { total: row?.total ?? 0, fromAddress: row?.fromAddress ?? 0 }
    },

    async claim(pubkey, addressHash, at, staleBefore) {
      await db
        .delete(faucetGrants)
        .where(
          and(
            eq(faucetGrants.pubkey, pubkey),
            isNull(faucetGrants.signature),
            lt(faucetGrants.grantedAt, staleBefore),
          ),
        )
      const taken = await db
        .insert(faucetGrants)
        .values({ pubkey, addressHash, grantedAt: at })
        .onConflictDoNothing({ target: faucetGrants.pubkey })
        .returning({ pubkey: faucetGrants.pubkey })
      if (taken.length > 0) return { claimed: true }
      const [held] = await db
        .select({ signature: faucetGrants.signature })
        .from(faucetGrants)
        .where(eq(faucetGrants.pubkey, pubkey))
      return { claimed: false, signature: held?.signature ?? null }
    },

    async settle(pubkey, signature) {
      await db.update(faucetGrants).set({ signature }).where(eq(faucetGrants.pubkey, pubkey))
    },

    async release(pubkey) {
      // Only an unsettled row: a grant whose signature is recorded happened.
      await db
        .delete(faucetGrants)
        .where(and(eq(faucetGrants.pubkey, pubkey), isNull(faucetGrants.signature)))
    },
  }
}
