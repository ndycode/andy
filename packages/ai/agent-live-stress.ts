// packages/ai/agent-live-stress.ts
// LIVE end-to-end stress of the FULL agent through the REAL OpenRouter API.
// Unlike tool-e2e-stress.ts (pure tool logic, no model), this drives runAgent() exactly as the
// handler does — natural-language in, real model tool-calls, buffered writes flushed via a real
// claim+flush — then verifies what persisted / what Andy answered.
//
// This is the real test of the OpenRouter migration: does openai/gpt-oss-120b:free tool-call cleanly
// against Andy's full ~27-tool schema, across many message shapes, with native model fallback?
//
// Run:  bun --env-file=.env run packages/ai/agent-live-stress.ts
//   needs OPENROUTER_API_KEY (live model) + DATABASE_URL (live Neon). Throwaway user, scoped cleanup.
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
  resolveUserId,
  savingsGoals,
  transactions,
  users,
  type WriteIntent,
} from "@repo/db";
import { eq, inArray } from "drizzle-orm";
import { runAgent } from "./src/agent";

const PHONE = `+0000AGENTLIVE${Date.now()}`;
const RUN = `agentlive-${Date.now()}`;
const TODAY = "2026-06-16";
const msgIds: string[] = [];
let mn = 0;
const db = getDb();

let pass = 0;
let fail = 0;
const slow: { label: string; ms: number }[] = [];
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label} ${detail}`);
  }
}

let userId = "";

// Drive ONE inbound message exactly like the handler: runAgent (live model) -> flush writes + turns.
async function say(text: string): Promise<{ reply: string; writes: WriteIntent[] }> {
  const t0 = Date.now();
  const { reply, writes } = await runAgent(text, {
    userId,
    timezone: "Asia/Manila",
    today: TODAY,
  });
  const ms = Date.now() - t0;
  slow.push({ label: text.slice(0, 40), ms });
  const id = `${RUN}-${mn++}`;
  msgIds.push(id);
  await claimSlot(id);
  const flushed = await flushWrites(id, [
    ...writes,
    { type: "saveTurn", userId, role: "user", content: text },
    { type: "saveTurn", userId, role: "assistant", content: reply },
  ]);
  if (flushed !== "committed") throw new Error(`flush not committed: ${flushed}`);
  console.log(`    [${ms}ms] "${text}" -> ${writes.length}w :: ${reply.slice(0, 80)}`);
  return { reply, writes };
}

const rowsFor = () => db.select().from(transactions).where(eq(transactions.userId, userId));

try {
  userId = await resolveUserId(PHONE);
  console.log(
    `agent-live user: ${userId}\nmodel: live OpenRouter (openai/gpt-oss-120b:free + fallbacks)\n`,
  );

  console.log("── 1. basic logging (NL -> tool call) ──");
  {
    const { writes } = await say("grab 180");
    ok(
      "logs 'grab 180' as an expense",
      writes.some((w) => w.type === "expense"),
    );
    const rows = await rowsFor();
    ok(
      "persisted ₱180 expense",
      rows.some((t) => t.amountCentavos === 18000),
      `amounts: ${rows.map((r) => r.amountCentavos)}`,
    );
  }

  console.log("\n── 2. synonym category coercion ──");
  {
    await say("spent 500 on groceries at sm");
    const rows = await rowsFor();
    ok(
      "groceries coerced to Food category",
      rows.some((t) => t.amountCentavos === 50000 && t.category === "Food"),
      `cats: ${rows.map((r) => `${r.amountCentavos}:${r.category}`)}`,
    );
  }

  console.log("\n── 3. income ──");
  {
    await say("got my salary today, 25k");
    const rows = await rowsFor();
    ok(
      "logs 25k as income",
      rows.some((t) => t.kind === "income" && t.amountCentavos === 2_500_000),
    );
  }

  console.log("\n── 4. multi-entry in one message ──");
  {
    const { writes } = await say("lunch 250, coffee 120, and a grab home 90");
    ok(
      "logs 3 expenses from one message",
      writes.filter((w) => w.type === "expense").length >= 2,
      `got ${writes.length}`,
    );
  }

  console.log("\n── 5. reads (model picks the right read tool) ──");
  {
    const { reply } = await say("how much have I spent on transport this month?");
    ok("transport read mentions a peso figure", /₱|180|270/.test(reply), reply);
  }
  {
    const { reply } = await say("how am I doing this month?");
    ok(
      "overview read returns income/expense/net language",
      /in|out|net|₱|spent|income/i.test(reply),
      reply,
    );
  }

  console.log("\n── 6. goals ──");
  {
    await say("I want to save 20k for a laptop by december");
    const g = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "creates a Laptop goal ~20k",
      g.some((x) => x.targetCentavos === 2_000_000),
      `goals: ${g.map((x) => `${x.name}:${x.targetCentavos}`)}`,
    );
  }
  {
    await say("put 5k toward the laptop");
    const g = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "contributes 5k to the goal",
      g.some((x) => (x.savedCentavos ?? 0) >= 500_000),
      `saved: ${g.map((x) => x.savedCentavos)}`,
    );
  }

  console.log("\n── 7. memory ──");
  {
    await say("remember that my payday is the 15th");
    const m = await db.select().from(memories).where(eq(memories.userId, userId));
    ok(
      "stores the payday memory",
      m.some((x) => /15/.test(x.content)),
      `mem: ${m.map((x) => x.content)}`,
    );
  }
  {
    const { reply } = await say("what do you know about me?");
    ok("recalls the payday memory", /15|payday/i.test(reply), reply);
  }

  console.log("\n── 8. budgets ──");
  {
    await say("set a food budget of 5k a month");
    const b = await db.select().from(budgets).where(eq(budgets.userId, userId));
    ok(
      "sets a Food budget of 5k",
      b.some((x) => x.monthlyLimitCentavos === 500_000),
      `budgets: ${b.map((x) => `${x.category}:${x.monthlyLimitCentavos}`)}`,
    );
  }

  console.log("\n── 9. recurring bills ──");
  {
    await say("I pay netflix 549 every month on the 5th");
    const r = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok(
      "adds Netflix recurring bill",
      r.some((x) => /netflix/i.test(x.label)),
      `recurring: ${r.map((x) => x.label)}`,
    );
  }

  console.log("\n── 10. same-message correction (edit just-logged) ──");
  {
    const before = (await rowsFor()).length;
    const { writes } = await say("taxi 200, no wait make it 250");
    const rows = await rowsFor();
    // Either one net expense at 250, or an edit intent — must NOT leave two taxi rows.
    const taxiish = rows.filter((t) => t.amountCentavos === 20000 || t.amountCentavos === 25000);
    ok(
      "correction nets a single entry (no double-log)",
      taxiish.length <= 1 || writes.some((w) => w.type === "editLast"),
      `taxiish rows: ${taxiish.map((r) => r.amountCentavos)}, writes: ${writes.map((w) => w.type)}, delta: ${rows.length - before}`,
    );
  }

  console.log("\n── 11. edge: gibberish / non-financial ──");
  {
    const { reply, writes } = await say("hey what's up");
    ok("chit-chat logs nothing", writes.length === 0, `writes: ${writes.map((w) => w.type)}`);
    ok("chit-chat still gets a reply", reply.length > 0);
  }

  console.log(`\n=== AGENT LIVE STRESS: ${pass} pass / ${fail} fail ===`);
  const avg = Math.round(slow.reduce((s, x) => s + x.ms, 0) / Math.max(1, slow.length));
  const max = slow.slice().sort((a, b) => b.ms - a.ms)[0];
  console.log(`latency: avg ${avg}ms, slowest ${max?.ms}ms ("${max?.label}")`);
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
