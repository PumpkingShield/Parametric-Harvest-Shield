import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { giveUpUpdate, verdictUpdate } from './reference-store.ts'

/**
 * What a verdict may touch — `FR-043`, `FR-044`, `T043`.
 *
 * A reference that wrote into the day — its class, its total, its root — would
 * be a second source of the index, and the one with tens of kilometres to a
 * pixel. So the writes are checked as SQL: the columns they set, and the rows
 * they may reach. `.toSQL()` builds the statement without opening a connection.
 */

// Never connected: `postgres()` is lazy, and `.toSQL()` sends nothing.
const db = drizzle(postgres('postgres://nobody@localhost:1/none'), { casing: 'snake_case' })

/** What an `update … set` writes, column by column — in the schema's order, not the call's. */
function written(query: { sql: string; params: unknown[] }): Record<string, unknown> {
  const set = /^update "cell_days" set (.*) where /.exec(query.sql)?.[1] ?? ''
  return Object.fromEntries(
    [...set.matchAll(/"([a-z_0-9]+)" = \$(\d+)/g)].map((match) => [
      match[1] ?? '',
      query.params[Number(match[2]) - 1],
    ]),
  )
}

describe('verdictUpdate', () => {
  it('sets the two reference columns and no column of the day itself', () => {
    const query = verdictUpdate(db, {
      cellId: 613_196_570_331_971_583n,
      dayIndex: 11,
      state: 'disputed',
      rainfallX100: 1_020,
    }).toSQL()

    expect(written(query)).toEqual({ reference_state: 'disputed', reference_rainfall_x100: 1_020 })
  })

  it('reaches only the one day, and only while its verdict is pending', () => {
    const query = verdictUpdate(db, {
      cellId: 613_196_570_331_971_583n,
      dayIndex: 11,
      state: 'agrees',
      rainfallX100: 0,
    }).toSQL()

    expect(query.sql).toMatch(
      / where \("cell_days"\."cell_id" = \$3 and "cell_days"\."day_index" = \$4 and "cell_days"\."reference_state" = \$5\)$/,
    )
    expect(query.params.slice(2)).toEqual([613_196_570_331_971_583n, 11, 'pending'])
  })
})

describe('giveUpUpdate', () => {
  it('marks the check absent and leaves the day as it is', () => {
    const query = giveUpUpdate(db, 4).toSQL()

    expect(written(query)).toEqual({ reference_state: 'unchecked' })
    expect(query.sql).toMatch(
      / where \("cell_days"\."reference_state" = \$2 and "cell_days"\."day_index" < \$3\)$/,
    )
    expect(query.params).toEqual(['unchecked', 'pending', 4])
  })

  it('on a clock with no real days, every pending day and no other', () => {
    const query = giveUpUpdate(db, null).toSQL()

    expect(written(query)).toEqual({ reference_state: 'unchecked' })
    expect(query.sql).toMatch(/ where "cell_days"\."reference_state" = \$2$/)
    expect(query.params).toEqual(['unchecked', 'pending'])
  })
})
