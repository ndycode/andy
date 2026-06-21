import { recurringItems } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import type { ToolE2eStressHarness } from "./tool-e2e-stress-harness";
import { arrayValue, firstResult, includesJsonText } from "./tool-e2e-stress-results";

export async function runRecurringChecks(harness: ToolE2eStressHarness): Promise<void> {
  const { db, ok, turn, userId } = harness;

  console.log("\n-- recurring bills --");
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
    const [row] = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok(
      "addRecurringBill persists monthly day 5",
      row?.label === "Netflix" && row?.dayOfMonth === 5,
    );
  }
  {
    const result = firstResult(
      await turn([
        {
          tool: "addRecurringBill",
          args: { label: "rent", amount: "8k", category: "Bills", cadence: "monthly" },
        },
      ]),
    );
    ok("monthly-without-day rejected", result.ok === false);
    const rows = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok("no bad recurring row persisted", rows.length === 1, `${rows.length}`);
  }
  {
    const result = firstResult(await turn([{ tool: "listRecurringBills", args: {} }]));
    ok(
      "listRecurringBills lists Netflix",
      includesJsonText(arrayValue(result, "recurring"), "Netflix"),
      JSON.stringify(result),
    );
  }
  {
    await turn([{ tool: "editRecurringBill", args: { label: "netflix", amount: "649" } }]);
    const [row] = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok(
      "editRecurringBill updates amount",
      row?.amountCentavos === 64_900,
      `got ${row?.amountCentavos}`,
    );
  }
  {
    await turn([{ tool: "removeRecurringBill", args: { label: "netflix" } }]);
    const rows = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok("removeRecurringBill deletes it", rows.length === 0);
  }
}
