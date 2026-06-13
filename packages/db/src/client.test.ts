import { describe, expect, test } from "bun:test";
import { isPoolerUrl } from "./client";

// isPoolerUrl decides whether to disable prepared statements (true = transaction-mode pooler).
// Pure + exported so the Neon/Supabase detection is unit-tested without a live DB. Getting this
// wrong silently breaks every query against a pooled endpoint (prepared statements can't survive
// PgBouncer transaction pooling).
describe("isPoolerUrl", () => {
  test("Neon pooled endpoint (-pooler host) → pooler", () => {
    expect(
      isPoolerUrl(
        "postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db?sslmode=require",
      ),
    ).toBe(true);
  });

  test("Neon direct endpoint (no -pooler) → not a pooler (prepared statements OK)", () => {
    expect(
      isPoolerUrl(
        "postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/db?sslmode=require",
      ),
    ).toBe(false); // direct Neon is NOT pooled → prepared statements OK
  });

  test("Supabase transaction pooler (:6543) → pooler", () => {
    expect(isPoolerUrl("postgresql://u:p@db.abcd.supabase.co:6543/postgres")).toBe(true);
  });

  test("Supabase direct (:5432) → not a pooler", () => {
    expect(isPoolerUrl("postgresql://u:p@db.abcd.supabase.co:5432/postgres")).toBe(false);
  });

  test("explicit pgbouncer=true flag → pooler", () => {
    expect(isPoolerUrl("postgresql://u:p@host/db?pgbouncer=true")).toBe(true);
  });

  test("plain local Postgres → not a pooler", () => {
    expect(isPoolerUrl("postgresql://postgres:postgres@localhost:5432/andy")).toBe(false);
  });
});
