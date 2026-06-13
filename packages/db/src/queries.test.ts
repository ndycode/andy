import { describe, expect, test } from "bun:test";
import { escapeLike, findMemoryToForget, matchGoals } from "./queries";

// Pure LIKE/ILIKE metacharacter escaping for searchTransactions. The DB query itself is
// integration-tested (no unit harness), but this escaping is pure and must be exact: without it,
// user search text leaks wildcard semantics into the pattern.
describe("escapeLike", () => {
  test("plain text is unchanged", () => {
    expect(escapeLike("grab")).toBe("grab");
    expect(escapeLike("jollibee lunch")).toBe("jollibee lunch");
  });

  test("escapes the single-char wildcard _", () => {
    // "grab_2" must match literally, not "grabx2"
    expect(escapeLike("grab_2")).toBe("grab\\_2");
  });

  test("escapes the multi-char wildcard %", () => {
    // "50%" must match literally, not "everything after 50"
    expect(escapeLike("50%")).toBe("50\\%");
  });

  test("escapes the backslash escape-char itself (first, no double-escape)", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  test("escapes a mix in one string", () => {
    expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
  });

  test("empty string stays empty", () => {
    expect(escapeLike("")).toBe("");
  });
});

// findMemoryToForget does its matching in SQL (replacing the old O(n) rows.find). We can't run real
// Postgres here, but we CAN assert its selection contract against a stub executor: it issues an
// EXACT-match query first and only falls back to a CONTAINS query when that's empty, never scans in
// JS, and short-circuits an empty query before touching the DB.
type StubRow = { id: string; content: string };
function stubExec(results: StubRow[][]) {
  let call = 0;
  const calls: number[] = [];
  // Each .select() chain resolves (awaited) to the next canned result set.
  const builder = (idx: number) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(results[idx] ?? []),
    };
    return chain;
  };
  const exec = {
    select: () => {
      const idx = call++;
      calls.push(idx);
      return builder(idx);
    },
  };
  return {
    exec: exec as unknown as Parameters<typeof findMemoryToForget>[0],
    queryCount: () => call,
  };
}

describe("findMemoryToForget (SQL-side selection contract)", () => {
  test("empty/whitespace query returns null WITHOUT querying the DB", async () => {
    const { exec, queryCount } = stubExec([]);
    expect(await findMemoryToForget(exec, "u1", "   ")).toBeNull();
    expect(queryCount()).toBe(0);
  });

  test("returns the exact match from the FIRST query, never runs the contains fallback", async () => {
    const { exec, queryCount } = stubExec([[{ id: "m1", content: "payday is the 15th" }]]);
    const hit = await findMemoryToForget(exec, "u1", "payday is the 15th");
    expect(hit).toEqual({ id: "m1", content: "payday is the 15th" });
    expect(queryCount()).toBe(1); // exact hit short-circuits; no second query
  });

  test("falls back to the contains query when exact is empty", async () => {
    const { exec, queryCount } = stubExec([[], [{ id: "m2", content: "likes oat milk tea" }]]);
    const hit = await findMemoryToForget(exec, "u1", "milk");
    expect(hit).toEqual({ id: "m2", content: "likes oat milk tea" });
    expect(queryCount()).toBe(2); // exact empty → ran the contains fallback
  });

  test("returns null when neither query matches", async () => {
    const { exec } = stubExec([[], []]);
    expect(await findMemoryToForget(exec, "u1", "nonexistent")).toBeNull();
  });
});

// matchGoals is the pure fuzzy goal resolver (M1 fix). It must NOT use the old over-broad
// query.includes(goalName) direction (which let "trip" match "my trip to japan savings"), it must
// prefer an exact case-insensitive match, and it must signal ambiguity so destructive callers can
// disambiguate instead of hitting an arbitrary row.
describe("matchGoals", () => {
  const g = (name: string) => ({ name });

  test("exact case-insensitive match wins and is unambiguous", () => {
    const r = matchGoals([g("Japan"), g("Japan Trip")], "japan");
    expect(r).toEqual({ kind: "one", goal: g("Japan") });
  });

  test("single substring match resolves to that goal", () => {
    const r = matchGoals([g("Emergency Fund"), g("Laptop")], "laptop");
    expect(r).toEqual({ kind: "one", goal: g("Laptop") });
  });

  test("multiple substring matches are AMBIGUOUS (no arbitrary pick)", () => {
    const r = matchGoals([g("Car Fund"), g("Car Insurance")], "car");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.goals).toHaveLength(2);
  });

  test("does NOT match on the reverse direction (query contains the goal name)", () => {
    // "trip" must NOT match "my trip to japan savings" via query.includes(name) — only name.includes(query).
    expect(matchGoals([g("trip")], "my trip to japan savings")).toEqual({ kind: "none" });
  });

  test("no match → none; empty query → none", () => {
    expect(matchGoals([g("Laptop")], "house")).toEqual({ kind: "none" });
    expect(matchGoals([g("Laptop")], "  ")).toEqual({ kind: "none" });
  });
});
