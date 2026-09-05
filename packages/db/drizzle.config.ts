import { defineConfig } from 'drizzle-kit'

/**
 * Migrations are generated from the schema and reviewed before they run.
 * DATABASE_URL points at the Supabase transaction pooler (:6543).
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  /**
   * Columns are snake_case in the database and camelCase in TypeScript. The
   * runtime client has to be constructed with the same option, or it will
   * look for columns that are not there.
   */
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})
