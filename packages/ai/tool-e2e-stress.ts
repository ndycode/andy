// packages/ai/tool-e2e-stress.ts
// FULL end-to-end stress of ALL 27 Andy tools against live Neon, exactly as the agent drives them:
//   build tools (fresh write buffer) -> call tool.execute(args) -> drain buffered intents ->
//   claimSlot(mid) -> flushWrites(mid, intents) -> verify what persisted via direct DB reads.
// Reads are asserted on the tool's returned value. Throwaway user, FK-safe scoped cleanup, fail-loud.
//
// Run:  bun run packages/ai/tool-e2e-stress.ts   (needs DATABASE_URL; no AI key — tools are pure logic)
import {
  budgets,
  claimSlot,
  flushWrites,
  getDb,
  habits,
  memories,
  messages,
  nudges,
  processedMessages,
  recurringItems,
  savingsGoals,
  transactions,
  users,
  type WriteIntent,
} from "@repo/db";
import { and, eq, inArray } from "drizzle-orm";
import { createWriteBuffer } from "./src/context";
import { buildTools } from "./src/tools";

const PHONE = `+0000TOOLE2E${Date.now()}`;
const RUN = `toole2e-${Date.now()}`;
const msgIds: string[] = [];
let n = 0;
const mid = () => {
  const id = `${RUN}-${n++}`;
  msgIds.push(id);
  return id;
};

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label} ${detail}`);
  }
}

const db = getDb();
const TODAY = "2026-06-14";

// Resolve the throwaway user id once via the same path the handler uses.
const { resolveUserId } = await import("@repo/db");
let userId = "";

// Drive a turn the way the handler does: fresh tools/buffer, run a sequence of (tool, args) calls,
// then flush whatever they buffered through a real claim+flush. Returns each tool's return value.
type ToolName = keyof ReturnType<typeof buildTools>;
async function turn(
  calls: { tool: ToolName; args: unknown }[],
  opts: {
    lastTransaction?: Parameters<typeof buildTools>[0]["lastTransaction"];
    memories?: string[];
  } = {},
): Promise<unknown[]> {
  const { addWrite, peek, drain } = createWriteBuffer();
  const tools = buildTools({
    userId,
    timezone: "Asia/Manila",
    today: TODAY,
    lastTransaction: opts.lastTransaction ?? null,
    memories: opts.memories ?? [],
    addWrite,
    peekWrites: peek,
  });
  const results: unknown[] = [];
  for (const c of calls) {
    const t = tools[c.tool] as { execute: (a: never, o: never) => unknown };
    results.push(await Promise.resolve(t.execute(c.args as never, {} as never)));
  }
  const intents = drain() as WriteIntent[];
  if (intents.length > 0) {
    const id = mid();
    await claimSlot(id);
    const flushed = await flushWrites(id, intents);
    if (flushed !== "committed") throw new Error(`flush not committed: ${flushed}`);
  }
  return results;
}

try {
  userId = await resolveUserId(PHONE);
  console.log(`tool-e2e user: ${userId}\n`);
  console.log("── logging ──");

  // 1. logExpense — buffers + persists; H2: synonym category coerced AND echoed as Other
  {
    const [r] = (await turn([
      { tool: "logExpense", args: { amount: "180", category: "Transport", note: "grab" } },
    ])) as { ok: boolean; category: string }[];
    ok("logExpense ok + echoes canonical category", r.ok === true && r.category === "Transport");
    const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
    ok(
      "logExpense persisted ₱180 Transport",
      rows.some((t) => t.amountCentavos === 18000 && t.category === "Transport"),
    );
  }
  {
    const [r] = (await turn([
      { tool: "logExpense", args: { amount: "500", category: "groceries", note: "sm" } },
    ])) as { ok: boolean; category: string }[];
    ok(
      "H2: logExpense echoes COERCED category (groceries→Other)",
      r.category === "Other",
      `got ${r.category}`,
    );
    const [row] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.note, "sm")));
    ok(
      "H2: stored category matches echo (Other)",
      row?.category === "Other",
      `stored ${row?.category}`,
    );
  }

  // 2. logIncome — always Income
  {
    await turn([{ tool: "logIncome", args: { amount: "25k", note: "sweldo" } }]);
    const [row] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.note, "sweldo")));
    ok(
      "logIncome persists 25k as Income",
      row?.kind === "income" && row?.amountCentavos === 2_500_000,
    );
  }

  // 3. backdating — logExpense with a valid past date
  {
    await turn([
      {
        tool: "logExpense",
        args: { amount: "800", category: "Food", note: "palengke", date: "2026-06-09" },
      },
    ]);
    const [row] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.note, "palengke")));
    ok(
      "backdate: localDate honored (2026-06-09)",
      row?.localDate === "2026-06-09",
      `got ${row?.localDate}`,
    );
  }
  // backdate guard: a future date must be rejected, nothing buffered
  {
    const [r] = (await turn([
      { tool: "logExpense", args: { amount: "10", category: "Food", date: "2099-01-01" } },
    ])) as { ok: boolean }[];
    ok("backdate guard: future date rejected (no write)", r.ok === false);
  }
  // bad amount rejected
  {
    const [r] = (await turn([
      { tool: "logExpense", args: { amount: "-5", category: "Food" } },
    ])) as { ok: boolean }[];
    ok("parseAmount guard: negative rejected", r.ok === false);
  }

  console.log("\n── reads (month-aware) ──");
  // 4-9. read tools answer from SQL. Current-month spend so far: Transport 180 + Food 500 + income.
  {
    const [r] = (await turn([{ tool: "getSpending", args: { category: "Transport" } }])) as {
      category: string;
      total: string;
    }[];
    ok("getSpending Transport = ₱180.00", r.total === "₱180.00", JSON.stringify(r));
  }
  {
    const [r] = (await turn([{ tool: "getOverview", args: {} }])) as {
      income: string;
      expenses: string;
    }[];
    ok("getOverview income reflects 25k", r.income === "₱25,000.00", JSON.stringify(r));
  }
  {
    const [r] = (await turn([{ tool: "getCategoryBreakdown", args: {} }])) as {
      breakdown: { category: string }[];
    }[];
    ok("getCategoryBreakdown returns rows", Array.isArray(r.breakdown) && r.breakdown.length > 0);
  }
  {
    const [r] = (await turn([{ tool: "getRecent", args: { limit: 5 } }])) as {
      transactions: unknown[];
    }[];
    ok("getRecent returns recent rows", Array.isArray(r.transactions) && r.transactions.length > 0);
  }
  {
    const [r] = (await turn([{ tool: "insights", args: {} }])) as Record<string, unknown>[];
    ok("insights returns a shape", r != null && typeof r === "object");
  }
  {
    // historical month query (May) — should be empty for this fresh user, resolves without error
    const [r] = (await turn([{ tool: "getOverview", args: { month: "2026-05" } }])) as {
      month: string;
    }[];
    ok("getOverview month-scoped (2026-05) resolves", r.month === "2026-05", JSON.stringify(r));
  }
  {
    const [r] = (await turn([{ tool: "searchHistory", args: { text: "grab" } }])) as
      | { results?: unknown[] }[]
      | Record<string, unknown>[];
    ok("searchHistory finds the grab note", JSON.stringify(r).toLowerCase().includes("grab"));
  }

  console.log("\n── goals ──");
  // 10. createGoal — resolves a deadline; 11. contributeToGoal; 12. getGoalStatus
  {
    await turn([
      { tool: "createGoal", args: { name: "Laptop", target: "20k", targetDate: "2026-12-31" } },
    ]);
    const [g] = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "createGoal persisted (Laptop, 20k, deadline)",
      g?.name === "Laptop" && g?.targetCentavos === 2_000_000 && g?.targetDate === "2026-12-31",
    );
  }
  {
    await turn([{ tool: "contributeToGoal", args: { goalName: "laptop", amount: "5k" } }]);
    const [g] = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "contributeToGoal adds to savedCentavos (5k)",
      g?.savedCentavos === 500_000,
      `got ${g?.savedCentavos}`,
    );
  }
  {
    const [r] = (await turn([{ tool: "getGoalStatus", args: { goalName: "laptop" } }])) as {
      goals: string[];
    }[];
    ok(
      "getGoalStatus reports progress",
      r.goals?.[0]?.includes("25%") ?? false,
      JSON.stringify(r.goals),
    );
  }
  // M3: same-turn create + contribute to a NOT-yet-existing goal → clear retry hint, not silent drop
  {
    const res = (await turn([
      { tool: "createGoal", args: { name: "Vacation", target: "30k" } },
      { tool: "contributeToGoal", args: { goalName: "vacation", amount: "5k" } },
    ])) as { ok: boolean; error?: string }[];
    ok(
      "M3: same-turn contribute returns retry hint (not silent drop)",
      res[1].ok === false && /just created/i.test(res[1].error ?? ""),
      JSON.stringify(res[1]),
    );
  }
  // editGoal
  {
    await turn([{ tool: "editGoal", args: { goalName: "laptop", target: "25k" } }]);
    const [g] = await db
      .select()
      .from(savingsGoals)
      .where(and(eq(savingsGoals.userId, userId), eq(savingsGoals.name, "Laptop")));
    ok(
      "editGoal updates target (25k)",
      g?.targetCentavos === 2_500_000,
      `got ${g?.targetCentavos}`,
    );
  }
  // deleteGoal — detaches contributions (kept as expenses), removes the goal
  {
    await turn([{ tool: "deleteGoal", args: { goalName: "vacation" } }]);
    const remaining = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "deleteGoal removes Vacation, keeps Laptop",
      remaining.length === 1 && remaining[0]?.name === "Laptop",
      `${remaining.map((g) => g.name)}`,
    );
  }

  console.log("\n── memory ──");
  // 13-15. remember / listMemory / forgetMemory
  {
    await turn([{ tool: "remember", args: { fact: "payday is the 15th", kind: "payday" } }]);
    const mem = await db.select().from(memories).where(eq(memories.userId, userId));
    ok("remember persists with kind", mem.length === 1 && mem[0]?.kind === "payday");
  }
  {
    // listMemory reads from ctx.memories (recalled at loop start) — pass it in
    const [r] = (await turn([{ tool: "listMemory", args: {} }], {
      memories: ["payday is the 15th"],
    })) as { memories?: unknown[] }[] | Record<string, unknown>[];
    ok("listMemory returns the recalled memory", JSON.stringify(r).includes("payday"));
  }
  {
    await turn([{ tool: "forgetMemory", args: { match: "payday" } }]);
    const mem = await db.select().from(memories).where(eq(memories.userId, userId));
    ok("forgetMemory removes it", mem.length === 0);
  }

  console.log("\n── recurring bills ──");
  // 16-19. add / list / edit / remove
  {
    await turn([
      {
        tool: "addRecurringBill",
        args: {
          label: "Netflix",
          amount: "549",
          category: "Entertainment",
          kind: "expense",
          cadence: "monthly",
          dayOfMonth: 5,
        },
      },
    ]);
    const [r] = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok("addRecurringBill persists (monthly day 5)", r?.label === "Netflix" && r?.dayOfMonth === 5);
  }
  // H1: monthly without a day → rejected, nothing buffered
  {
    const [r] = (await turn([
      {
        tool: "addRecurringBill",
        args: { label: "rent", amount: "8k", category: "Bills", cadence: "monthly" },
      },
    ])) as { ok: boolean }[];
    ok("H1: monthly-without-day rejected (no flush-abort)", r.ok === false);
    const rows = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok("H1: no bad recurring row persisted", rows.length === 1, `${rows.length}`);
  }
  {
    const [r] = (await turn([{ tool: "listRecurringBills", args: {} }])) as {
      recurring: unknown[];
    }[];
    ok("listRecurringBills lists Netflix", JSON.stringify(r.recurring).includes("Netflix"));
  }
  {
    await turn([{ tool: "editRecurringBill", args: { label: "netflix", amount: "649" } }]);
    const [r] = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok(
      "editRecurringBill updates amount (649)",
      r?.amountCentavos === 64900,
      `got ${r?.amountCentavos}`,
    );
  }
  {
    await turn([{ tool: "removeRecurringBill", args: { label: "netflix" } }]);
    const rows = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok("removeRecurringBill deletes it", rows.length === 0);
  }

  console.log("\n── budgets + analytics ──");
  // 20-22. setBudget / getBudgets / removeBudget
  {
    const [r] = (await turn([
      { tool: "setBudget", args: { category: "Food", monthlyLimit: "5k" } },
    ])) as { category: string }[];
    ok("setBudget echoes coerced category", r.category === "Food");
    const [b] = await db.select().from(budgets).where(eq(budgets.userId, userId));
    ok("setBudget persists (Food 5k)", b?.monthlyLimitCentavos === 500_000);
  }
  {
    const [r] = (await turn([{ tool: "getBudgets", args: {} }])) as {
      budgets: { category: string }[];
    }[];
    ok(
      "getBudgets shows Food with spend",
      r.budgets?.some((x) => x.category === "Food"),
    );
  }
  {
    const [r] = (await turn([{ tool: "getSpendingPace", args: { category: "Food" } }])) as Record<
      string,
      unknown
    >[];
    ok("getSpendingPace returns a projection shape", r != null && typeof r === "object");
  }
  {
    const [r] = (await turn([
      { tool: "compareSpending", args: { current: "2026-06", previous: "2026-05" } },
    ])) as Record<string, unknown>[];
    ok("compareSpending resolves two months", r != null && typeof r === "object");
  }
  {
    await turn([{ tool: "removeBudget", args: { category: "Food" } }]);
    const rows = await db.select().from(budgets).where(eq(budgets.userId, userId));
    ok("removeBudget deletes it", rows.length === 0);
  }

  console.log("\n── corrections (edit/delete last) ──");
  // 23-24. editLast / deleteLast against a real lastTransaction snapshot
  {
    const [last] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.note, "grab")));
    if (!last) throw new Error("editLast setup: expected the seeded 'grab' transaction");
    const snap = {
      id: last.id,
      kind: last.kind,
      amountCentavos: last.amountCentavos,
      category: last.category,
      note: last.note,
      goalId: last.goalId,
    };
    await turn([{ tool: "editLast", args: { amount: "200" } }], { lastTransaction: snap });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, last.id));
    ok(
      "editLast edits the snapshot row (180→200)",
      row?.amountCentavos === 20000,
      `got ${row?.amountCentavos}`,
    );
  }
  {
    const [last] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.note, "grab")));
    if (!last) throw new Error("deleteLast setup: expected the (edited) 'grab' transaction");
    const snap = {
      id: last.id,
      kind: last.kind,
      amountCentavos: last.amountCentavos,
      category: last.category,
      note: last.note,
      goalId: last.goalId,
    };
    await turn([{ tool: "deleteLast", args: {} }], { lastTransaction: snap });
    const gone = await db.select().from(transactions).where(eq(transactions.id, last.id));
    ok("deleteLast removes the snapshot row", gone.length === 0);
  }

  console.log(`\n=== TOOL E2E: ${pass} pass / ${fail} fail ===`);
} catch (err) {
  fail++;
  console.error("\n✗ THREW:", err instanceof Error ? (err.stack ?? err.message) : err);
} finally {
  console.log("\ncleaning up throwaway user...");
  if (userId) {
    for (const tbl of [
      transactions,
      savingsGoals,
      budgets,
      memories,
      habits,
      recurringItems,
      messages,
      nudges,
    ]) {
      await db
        .delete(tbl)
        .where(eq(tbl.userId, userId))
        .catch(() => {});
    }
    await db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => {});
  }
  if (msgIds.length > 0) {
    await db
      .delete(processedMessages)
      .where(inArray(processedMessages.messageId, msgIds))
      .catch(() => {});
  }
  console.log(`cleanup done (${msgIds.length} markers, user ${userId || "none"}).`);
  process.exit(fail > 0 ? 1 : 0);
}
