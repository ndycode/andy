import { afterAll, beforeAll, beforeEach, describe } from "bun:test";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const runIntegration = TEST_DATABASE_URL ? describe : describe.skip;

if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type DbPackage = typeof import("./index");
type IntegrationSql = import("postgres").Sql;

type DbIntegrationHarness = {
  readonly db: () => DbPackage;
  readonly sql: () => IntegrationSql;
  readonly claimTtlMs: () => number;
};

class IntegrationHarnessError extends Error {
  constructor(label: string) {
    super(`missing integration test value: ${label}`);
    this.name = "IntegrationHarnessError";
  }
}

function requireHarnessValue<T>(value: T | null, label: string): T {
  if (value === null) throw new IntegrationHarnessError(label);
  return value;
}

export function describeDbIntegration(name: string, fn: () => void): void {
  runIntegration(name, fn);
}

export function useDbIntegration(): DbIntegrationHarness {
  let q: DbPackage | null = null;
  let sql: IntegrationSql | null = null;
  let claimTtlMs: number | null = null;

  beforeAll(async () => {
    const testUrl = requireHarnessValue(TEST_DATABASE_URL ?? null, "TEST_DATABASE_URL");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    sql = postgres(testUrl, { max: 1, prepare: false });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    await migrate(drizzle(sql), { migrationsFolder });
    q = await import("./index");
    ({ CLAIM_TTL_MS: claimTtlMs } = await import("./claim-queries"));
  });

  afterAll(async () => {
    const currentSql = sql;
    if (currentSql) await currentSql.end();
  });

  beforeEach(async () => {
    const currentSql = requireHarnessValue(sql, "postgres sql");
    await currentSql`TRUNCATE users, transactions, savings_goals, budgets, recurring_items, memories, messages, nudges, processed_messages, habits, summary_runs RESTART IDENTITY CASCADE`;
  });

  return {
    db: () => requireHarnessValue(q, "db package"),
    sql: () => requireHarnessValue(sql, "postgres sql"),
    claimTtlMs: () => requireHarnessValue(claimTtlMs, "claim ttl"),
  };
}

export function requireRow<T>(row: T | undefined, label: string): T {
  return requireHarnessValue(row ?? null, label);
}

export async function expectDbRejection(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
  throw new IntegrationHarnessError("expected DB operation to reject");
}
