import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * IMPORTANT (verification C1): use a TCP/SESSION connection string with the postgres-js driver.
 * We rely on db.transaction() (the claim/flush dedup design), so the HTTP drivers that don't support
 * transactions are unusable here:
 *   - Neon's neon-http driver throws "No transactions support".
 *   - Always pass a TCP connection string (Neon, Supabase, or any Postgres). SSL is taken from the
 *     URL (Neon/Supabase strings include `sslmode=require`).
 *
 * Transaction-mode poolers (PgBouncer) can't keep prepared statements across pooled backends, so
 * `prepare` MUST be false when the URL points at one. Detected hosts/markers:
 *   - Supabase transaction pooler: port `:6543`
 *   - Neon pooled endpoint: a `-pooler` host (e.g. `ep-xxx-pooler.<region>.aws.neon.tech`)
 *   - Generic: an explicit `pgbouncer=true` flag
 * A DIRECT endpoint (Neon direct host, Supabase `:5432`) supports prepared statements → prepare:true.
 *
 * Lazy singleton: do NOT connect at import time, so modules that only import types
 * (or tools tested without a DB) don't require DATABASE_URL to be set.
 */
let _db: PostgresJsDatabase<typeof schema> | null = null;

/** True if the connection string targets a transaction-mode pooler (no prepared statements). */
export function isPoolerUrl(url: string): boolean {
  return (
    url.includes(":6543") || // Supabase transaction pooler
    url.includes("-pooler") || // Neon pooled endpoint host
    url.includes("pgbouncer=true") // explicit PgBouncer flag
  );
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const isPooler = isPoolerUrl(url);
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
