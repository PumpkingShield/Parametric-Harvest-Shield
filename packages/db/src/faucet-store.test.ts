import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { pgFaucetStore } from './faucet-store.ts'

/**
 * The faucet's ledger is a lock, and a lock is its SQL — `T038a`. Captured
 * rather than run, as in `reputation-store.test.ts`.
 */

function capturing(): { db: PostgresJsDatabase<Record<string, never>>; statements: string[] } {
  const statements: string[] = []
  const db = drizzle<Record<string, never>>(postgres('postgres://nobody@localhost:1/none'), {
    casing: 'snake_case',
    logger: { logQuery: (query) => statements.push(query) },
  })
  return { db, statements }
}

describe('pgFaucetStore', () => {
  it('clears a stale unsettled row of the key before taking it', async () => {
    const { db, statements } = capturing()
    await pgFaucetStore(db)
      .claim('key', 'hash', new Date(0), new Date(0))
      .catch(() => undefined)
    expect(statements[0]).toBe(
      'delete from "faucet_grants" where ("faucet_grants"."pubkey" = $1 and ' +
        '"faucet_grants"."signature" is null and "faucet_grants"."granted_at" < $2)',
    )
  })

  it('gives back only a row whose transaction was never recorded', async () => {
    const { db, statements } = capturing()
    await pgFaucetStore(db)
      .release('key')
      .catch(() => undefined)
    expect(statements).toEqual([
      'delete from "faucet_grants" where ("faucet_grants"."pubkey" = $1 and ' +
        '"faucet_grants"."signature" is null)',
    ])
  })

  it('counts every grant in the window and, filtered, the caller’s', async () => {
    const { db, statements } = capturing()
    await pgFaucetStore(db)
      .countsSince(new Date(0), 'hash')
      .catch(() => undefined)
    expect(statements).toEqual([
      'select count(*), count(*) filter (where "address_hash" = $1) from "faucet_grants" ' +
        'where "faucet_grants"."granted_at" >= $2',
    ])
  })
})
