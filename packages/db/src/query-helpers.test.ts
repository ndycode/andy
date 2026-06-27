import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  addDaysToLocalDate,
  escapeLike,
  matchGoals,
  matchRecurring,
  noteKeywords,
  pickRecurringMatch,
} from "./query-helpers";

describe("query helpers", () => {
  test("matchRecurring is a 3-state match: exact wins, single contains, ambiguous", () => {
    const rows = [{ label: "Netflix" }, { label: "Netgear lease" }];
    expect(matchRecurring(rows, "netflix")).toEqual({ kind: "one", item: { label: "Netflix" } });
    expect(matchRecurring([{ label: "Rent" }], "ren")).toEqual({
      kind: "one",
      item: { label: "Rent" },
    });
    expect(matchRecurring(rows, "net").kind).toBe("ambiguous");
    expect(matchRecurring(rows, "spotify")).toEqual({ kind: "none" });
    expect(matchRecurring(rows, "  ")).toEqual({ kind: "none" });
  });

  test("pickRecurringMatch prefers exact label matches before contains matches", () => {
    const rows = [{ label: "Netflix Family" }, { label: "Netflix" }];

    expect(pickRecurringMatch(rows, "netflix")).toEqual({ label: "Netflix" });
    expect(pickRecurringMatch(rows, "family")).toEqual({ label: "Netflix Family" });
    expect(pickRecurringMatch(rows, "   ")).toBeNull();
  });

  test("addDaysToLocalDate uses calendar-day arithmetic across month and leap boundaries", () => {
    expect(addDaysToLocalDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToLocalDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToLocalDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("noteKeywords folds case, drops stopwords, numbers, tiny words, and de-dupes", () => {
    expect(noteKeywords("Paid Grab grab 123 at SM")).toEqual(["grab"]);
    expect(noteKeywords("Coffee with Ana at BGC")).toEqual(["coffee", "ana", "bgc"]);
  });

  test("escapeLike escapes Postgres LIKE metacharacters literally", () => {
    expect(escapeLike("grab")).toBe("grab");
    expect(escapeLike("jollibee lunch")).toBe("jollibee lunch");
    expect(escapeLike("grab_2")).toBe("grab\\_2");
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
    expect(escapeLike("")).toBe("");
  });

  test("matchGoals prefers exact case-insensitive matches", () => {
    const goals = [{ name: "Japan" }, { name: "Japan Trip" }];

    expect(matchGoals(goals, "japan")).toEqual({ kind: "one", goal: { name: "Japan" } });
  });

  test("matchGoals resolves a single substring match", () => {
    const goals = [{ name: "Emergency Fund" }, { name: "Laptop" }];

    expect(matchGoals(goals, "laptop")).toEqual({ kind: "one", goal: { name: "Laptop" } });
  });

  test("matchGoals reports ambiguous substring matches", () => {
    const goals = [{ name: "Car Fund" }, { name: "Car Insurance" }];

    expect(matchGoals(goals, "car").kind).toBe("ambiguous");
  });

  test("matchGoals does not match when only the query contains the goal name", () => {
    expect(matchGoals([{ name: "trip" }], "my trip to japan savings")).toEqual({ kind: "none" });
  });

  test("matchGoals returns none for no match or blank query", () => {
    expect(matchGoals([{ name: "Laptop" }], "house")).toEqual({ kind: "none" });
    expect(matchGoals([{ name: "Laptop" }], "  ")).toEqual({ kind: "none" });
  });

  test("matchGoals keeps single-match narrowing free of type assertions", () => {
    const source = readFileSync(new URL("./query-helpers.ts", import.meta.url), "utf8");

    expect(source).not.toContain("contains[0] as T");
  });
});
