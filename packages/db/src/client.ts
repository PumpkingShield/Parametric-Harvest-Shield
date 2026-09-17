import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

/**
 * The one place a connection to Postgres is opened.
 *
 * The stores (`pgReadingStore`, `pgIntervalStore`, `pgRegistryStore`) take a
 * `PostgresJsDatabase` and know nothing about how it was made, which is what
 * keeps every route and every dispatcher testable without a database. This is
 * the other half: the two processes need a real handle, and the two settings
 * that make it a *working* handle are not obvious enough to be restated in
 * each of them.
 *
 * **`prepare: false` is mandatory, not a preference.** `DATABASE_URL` points at
 * the Supabase transaction pooler (`:6543`), which hands a different backend to
 * every transaction; a prepared statement named on one backend and executed on
 * another fails with `prepared statement "s1" does not exist`, intermittently,
 * under load, and only in production. The session port (`:5432`) would allow
 * prepared statements and does not survive two services plus migrations on the
 * free tier.
 *
 * **`casing: 'snake_case'` must match `drizzle.config.ts`.** The migrations are
 * generated with it, so the columns in the database are snake_case while the
 * schema names them in camelCase. A client built without it looks for columns
 * that are not there — and it looks for them at query time, not at startup.
 */

export type DbHandle = {
  db: PostgresJsDatabase<Record<string, never>>
  /** Closes the pool and waits for in-flight queries — the shutdown path. */
  close(): Promise<void>
}

export type DbOptions = {
  /**
   * Connections in the pool.
   *
   * Small on purpose: Supabase's free tier counts pooler connections across
   * every service, and there are three of them (api, worker, migrations). The
   * work here is short queries, not long transactions, so a deeper pool buys
   * nothing a queue does not.
   */
  max?: number
  /** Seconds a query may run before the driver gives up. */
  connectTimeoutSeconds?: number
}

export const DEFAULT_POOL_SIZE = 5
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10

export function createDb(url: string, options: DbOptions = {}): DbHandle {
  if (url.trim() === '') {
    throw new Error('DATABASE_URL is empty')
  }

  const client = postgres(url, {
    prepare: false,
    max: options.max ?? DEFAULT_POOL_SIZE,
    connect_timeout: options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
  })

  return {
    db: drizzle(client, { casing: 'snake_case' }),
    async close() {
      // Not `{ timeout: 0 }`: a shutdown that cancels a half-written day would
      // leave a `cell_days` row the aggregator cannot tell from one it never
      // wrote. Letting the query finish is the whole point of the graceful
      // path, and the process has its own deadline above this one.
      await client.end()
    },
  }
}
