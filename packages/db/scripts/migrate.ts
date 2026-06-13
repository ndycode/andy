/**
 * Apply pending Drizzle migrations to DATABASE_URL. Works against Neon, Supabase, or any Postgres.
 *
 * Usage:  DATABASE_URL=postgres://… bun run db:migrate
 *
 * Notes:
 *  - Uses the postgres-js migrator (NOT neon-http) so it matches the runtime driver and supports the
 *    transactional DDL drizzle wraps each migration in.
 *  - A dedicated short-lived connection with max:1 and prepare:false — DDL doesn't need prepared
 *    statements, and prepare:false is also required if DATABASE_URL points at a transaction pooler.
 *    For migrations PREFER the DIRECT (non-pooler) endpoint; some PgBouncer setups reject the
 *    advisory locks / multi-statement DDL the migrator uses.
 *  - Idempotent: drizzle tracks applied migrations in its __drizzle_migrations table, so re-running
 *    only applies what's new.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (e.g. a Neon connection string with sslmode=require).");
  process.exit(1);
}

if (url.includes("-pooler") || url.includes(":6543") || url.includes("pgbouncer=true")) {
  console.warn(
    "⚠️  DATABASE_URL looks like a pooled endpoint. Migrations should use the DIRECT endpoint; " +
      "proceeding, but if it hangs or errors on locks, switch to the direct connection string.",
  );
}

const sql = postgres(url, { max: 1, prepare: false });
const db = drizzle(sql);

try {
  console.log("Applying migrations from ./migrations …");
  await migrate(db, { migrationsFolder: "./migrations" });
  console.log("✅ Migrations applied (or already up to date).");
} catch (err) {
  console.error("❌ Migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
