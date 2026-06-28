import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { learnHabit, topHabits } from "./habit-queries";

describe("habit queries module boundary", () => {
  test("exports habit learning and prompt recall entrypoints", () => {
    expect(typeof learnHabit).toBe("function");
    expect(typeof topHabits).toBe("function");
  });

  test("topHabits stays backed by the user/count prompt index", () => {
    const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
    const query = readFileSync(new URL("./habit-queries.ts", import.meta.url), "utf8");
    const migration = readFileSync(
      new URL("../migrations/0012_cool_gauntlet.sql", import.meta.url),
      "utf8",
    );

    expect(schema).toContain('index("habits_user_count_idx").on(');
    expect(schema).toContain("t.count.desc()");
    expect(schema).toContain("t.updatedAt.desc()");
    expect(query).toContain("habits.count");
    expect(query).toContain("habits.updatedAt");
    expect(query).toContain("habits.merchant");
    expect(migration).toContain('CREATE INDEX "habits_user_count_idx"');
    expect(migration).toContain('"count" DESC');
    expect(migration).toContain('"updated_at" DESC');
  });
});
