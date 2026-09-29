import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { votingSensor } from './interval-store.ts'
import { sensors } from './schema.ts'

/**
 * Who votes — `FR-050`, `FR-012`, `T076`.
 *
 * A median taken over the wrong set still produces a plausible number, so the
 * condition is checked as SQL rather than trusted: the three clauses, on the
 * `sensors` table, with the minimum bound as a parameter. `.toSQL()` builds
 * the statement without opening a connection.
 */

// Never connected: `postgres()` is lazy, and `.toSQL()` sends nothing.
const db = drizzle(postgres('postgres://nobody@localhost:1/none'), { casing: 'snake_case' })

describe('votingSensor', () => {
  it('counts a sensor only if it is on chain, not excluded and staked at least the minimum', () => {
    const query = db
      .select({ pubkey: sensors.pubkey })
      .from(sensors)
      .where(votingSensor(1_000_000n))
      .toSQL()

    expect(query.sql).toBe(
      'select "pubkey" from "sensors" where ("sensors"."mirrored_at" is not null and ' +
        '"sensors"."active" = $1 and "sensors"."stake" >= $2)',
    )
    expect(query.params).toEqual([true, 1_000_000n])
  })

  it('still requires the chain when the pool asks for no stake at all', () => {
    // `min_stake = 0` is a pool the program accepts. A row only the scenario
    // door wrote has a stake of zero, and must not vote on the strength of it.
    const query = db.select().from(sensors).where(votingSensor(0n)).toSQL()
    expect(query.sql).toContain('"sensors"."mirrored_at" is not null')
  })

  it('refuses a negative minimum', () => {
    expect(() => votingSensor(-1n)).toThrow(RangeError)
  })
})
