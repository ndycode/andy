import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * IMPORTANT (verification C1): use a TCP/SESSION connection string.
 * Neon's neon-http driver throws "No transactions support" — we need db.transaction().
 * On a Supabase transaction-mode pooler (port 6543), set prepare:false.
 *
 * Lazy singleton: do NOT connect at import time, so modules that only import types
 * (or tools tested without a DB) don't require DATABASE_URL to be set.
 */
let _db: PostgresJsDatabase<typeof schema> | null = null;

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const isPooler = url.includes(":6543") || url.includes("pgbouncer=true");
  // Serverless/Fluid: one logical connection per instance is plenty for this single-user app,
  // and keeps us well under free-tier pooler limits. prepare:false is required on a
  // transaction-mode pooler (it can't keep prepared statements across pooled backends).
  _db = drizzle(
    postgres(url, {
      prepare: !isPooler,
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    }),
    { schema },
  );
  return _db;
}

export type DB = PostgresJsDatabase<typeof schema>;
export { schema };
