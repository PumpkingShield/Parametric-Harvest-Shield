import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { pgReputationStore } from './reputation-store.ts'

/**
 * Reputation is counted, not trusted — `FR-011`, `T034`. The statement is
 * captured rather than run: a count over the wrong rows is still a plausible
 * number, and only the SQL says which rows it was.
 */

function capturing(): { db: PostgresJsDatabase<Record<string, never>>; statements: string[] } {
  const statements: string[] = []
  // Never connected: `postgres()` is lazy, and the logger sees the statement
  // before the driver would have to open anything.
  const db = drizzle<Record<string, never>>(postgres('postgres://nobody@localhost:1/none'), {
    casing: 'snake_case',
    logger: { logQuery: (query) => statements.push(query) },
  })
  return { db, statements }
}

describe('pgReputationStore.counts', () => {
  it('counts judged and outlier intervals per sensor over pool days, both ends inclusive', async () => {
    const { db, statements } = capturing()
    await pgReputationStore(db)
      .counts(10, 23)
      .catch(() => undefined)

    // Drizzle drops the table from a column inside a select's `sql` — safe
    // here only because the statement reads one table. A join added to this
    // query has to put the qualifier back by hand.
    expect(statements).toEqual([
      'select "sensor_pubkey", count(*), count(*) filter (where "outlier") ' +
        'from "sensor_verdicts" where ("sensor_verdicts"."day_index" >= $1 and ' +
        '"sensor_verdicts"."day_index" <= $2) group by "sensor_verdicts"."sensor_pubkey" ' +
        'order by "sensor_verdicts"."sensor_pubkey" asc',
    ])
  })

  it('asks nothing for an empty window', async () => {
    const { db, statements } = capturing()
    expect(await pgReputationStore(db).counts(5, 4)).toEqual([])
    expect(statements).toEqual([])
  })
})
