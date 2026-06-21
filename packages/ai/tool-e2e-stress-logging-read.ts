import { transactions } from "@repo/db/schema";
import { and, eq } from "drizzle-orm";
import type { ToolE2eStressHarness } from "./tool-e2e-stress-harness";
import { arrayValue, firstResult, includesJsonText, stringValue } from "./tool-e2e-stress-results";

export async function runLoggingReadChecks(harness: ToolE2eStressHarness): Promise<void> {
  const { db, ok, turn, userId } = harness;

  console.log("-- logging --");
  {
    const result = firstResult(
      await turn([
        { tool: "logExpense", args: { amount: "180", category: "Transport", note: "grab" } },
      ]),
    );
    ok(
      "logExpense ok + echoes canonical category",
      result.ok === true && stringValue(result, "category") === "Transport",
    );
    const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
    ok(
      "logExpense persisted P180 Transport",
      rows.some(
        (transaction) =>
          transaction.amountCentavos === 18_000 && transaction.category === "Transport",
      ),
    );
  }
  {
    const result = firstResult(
      await turn([
        { tool: "logExpense", args: { amount: "500", category: "groceries", note: "sm" } },
      ]),
    );
    ok(
      "synonym category coerced + echoed",
      stringValue(result, "category") === "Food",
      `got ${stringValue(result, "category")}`,
    );
    const [row] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.note, "sm")));
    ok("stored category matches echo", row?.category === "Food", `stored ${row?.category}`);
  }
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
    ok("backdate localDate honored", row?.localDate === "2026-06-09", `got ${row?.localDate}`);
  }
  {
    const result = firstResult(
      await turn([
        { tool: "logExpense", args: { amount: "10", category: "Food", date: "2099-01-01" } },
      ]),
    );
    ok("backdate guard rejects future date", result.ok === false);
  }
  {
    const result = firstResult(
      await turn([{ tool: "logExpense", args: { amount: "-5", category: "Food" } }]),
    );
    ok("parseAmount guard rejects negative", result.ok === false);
  }

  console.log("\n-- reads --");
  {
    const result = firstResult(
      await turn([{ tool: "getSpending", args: { category: "Transport" } }]),
    );
    ok(
      "getSpending Transport = P180.00",
      stringValue(result, "total") === "₱180.00",
      JSON.stringify(result),
    );
  }
  {
    const result = firstResult(await turn([{ tool: "getOverview", args: {} }]));
    ok(
      "getOverview income reflects 25k",
      stringValue(result, "income") === "₱25,000.00",
      JSON.stringify(result),
    );
  }
  {
    const result = firstResult(await turn([{ tool: "getCategoryBreakdown", args: {} }]));
    ok("getCategoryBreakdown returns rows", arrayValue(result, "breakdown").length > 0);
  }
  {
    const result = firstResult(await turn([{ tool: "getRecent", args: { limit: 5 } }]));
    ok("getRecent returns recent rows", arrayValue(result, "transactions").length > 0);
  }
  {
    const result = firstResult(await turn([{ tool: "insights", args: {} }]));
    ok("insights returns a shape", result != null && typeof result === "object");
  }
  {
    const result = firstResult(await turn([{ tool: "getOverview", args: { month: "2026-05" } }]));
    ok(
      "getOverview month-scoped resolves",
      stringValue(result, "month") === "2026-05",
      JSON.stringify(result),
    );
  }
  {
    const result = firstResult(await turn([{ tool: "searchHistory", args: { text: "grab" } }]));
    ok("searchHistory finds the grab note", includesJsonText(result, "grab"));
  }
}
