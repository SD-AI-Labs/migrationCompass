import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { databaseEnv, isConfigured } from "@/lib/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let sql: postgres.Sql | undefined;
let db: Database | undefined;

/**
 * Lazily connects. Importing this module must never open a socket — the
 * scorecard's pure paths and the unit suite import route modules that
 * transitively pull this in, and neither should require a live Postgres.
 */
export function getDb(): Database {
  if (!db) {
    const { DATABASE_URL } = databaseEnv();
    sql = postgres(DATABASE_URL, {
      max: 5,
      // Notices are noise; real errors still surface as thrown exceptions.
      onnotice: () => {},
    });
    db = drizzle(sql, { schema });
  }
  return db;
}

export const hasDatabaseConfig = (): boolean => isConfigured(databaseEnv);

export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
  db = undefined;
}

export { schema };
