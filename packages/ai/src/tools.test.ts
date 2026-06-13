import { describe, expect, test } from "bun:test";
import type { LastTransaction, WriteIntent } from "@repo/db";
import { createWriteBuffer } from "./context";
import { buildTools } from "./tools";

function ctxWithBuffer(opts?: { lastTransaction?: LastTransaction | null; memories?: string[] }) {
  const { addWrite, peek, drain } = createWriteBuffer();
  const tools = buildTools({
    userId: "user-1",
    timezone: "Asia/Manila",
    today: "2026-06-11",
    lastTransaction: opts?.lastTransaction ?? null,
    memories: opts?.memories ?? [],
    addWrite,
    peekWrites: peek,
  });
  return { tools, drain };
}

const sampleLast: LastTransaction = {
  id: "tx-last",
  kind: "expense",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  goalId: null,
};

// In AI SDK v6 a tool's runtime callback is `execute`; call it directly to test logic.
type ToolResult = { ok: boolean; [k: string]: unknown };
type ExecutableTool = { execute?: (args: never, opts: never) => unknown };
function run(t: ExecutableTool, args: unknown): Promise<ToolResult> {
  if (!t.execute) throw new Error("tool has no execute");
  return Promise.resolve(t.execute(args as never, {} as never) as ToolResult);
}

describe("write-tools buffer intents (no DB during agent run)", () => {
  test("logExpense buffers a parsed expense intent (AC1)", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    expect(res).toMatchObject({ ok: true, logged: "₱180.00", category: "Transport" });
    const writes = drain();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      type: "expense",
      userId: "user-1",
      amountCentavos: 18000,
      category: "Transport",
      localDate: "2026-06-11",
    });
  });

  test("logIncome buffers income with 25k -> 2,500,000c (AC2)", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.logIncome, { amount: "25k", note: "sweldo" });
    expect(drain()[0]).toMatchObject({
      type: "income",
      amountCentavos: 2_500_000,
      category: "Income",
    });
  });

  test("AC11: three entries in one turn buffer three intents", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await run(tools.logExpense, { amount: "250", category: "Food", note: "jollibee" });
    await run(tools.logIncome, { amount: "25k" });
    const writes = drain();
    const amounts = writes.map((w: WriteIntent) =>
      "amountCentavos" in w ? w.amountCentavos : undefined,
    );
    expect(amounts).toEqual([18000, 25000, 2_500_000]);
    expect(writes.map((w: WriteIntent) => w.type)).toEqual(["expense", "expense", "income"]);
  });

  test("bad amount does not buffer a write", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.logExpense, { amount: "abc", category: "Food" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("unknown category coerced to Other", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.logExpense, { amount: "50", category: "Other" });
    expect(drain()[0]).toMatchObject({ category: "Other" });
  });
});

describe("createGoal buffers a goal intent", () => {
  test("'save 20k for laptop by Dec' parses target + buffers", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.createGoal, {
      name: "Laptop",
      target: "20k",
      targetDate: "2026-12-31",
    });
    expect(res.ok).toBe(true);
    expect(drain()[0]).toMatchObject({
      type: "createGoal",
      userId: "user-1",
      name: "Laptop",
      targetCentavos: 2_000_000,
      targetDate: "2026-12-31",
    });
  });

  test("goal with no deadline buffers null targetDate", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.createGoal, { name: "Emergency Fund", target: "50k" });
    expect(drain()[0]).toMatchObject({ targetCentavos: 5_000_000, targetDate: null });
  });

  test("bad target does not buffer", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.createGoal, { name: "X", target: "abc" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("a valid YYYY-MM-DD deadline is accepted", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.createGoal, {
      name: "Trip",
      target: "30k",
      targetDate: "2026-12-25",
    });
    expect(res).toMatchObject({ ok: true, targetDate: "2026-12-25" });
    expect(drain()[0]).toMatchObject({ targetDate: "2026-12-25" });
  });

  test("a raw natural-language deadline is rejected (no bad date reaches the DB)", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.createGoal, {
      name: "Trip",
      target: "30k",
      targetDate: "december",
    });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("a non-calendar deadline (Feb 30) is rejected", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.createGoal, {
      name: "Trip",
      target: "30k",
      targetDate: "2026-02-30",
    });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});

describe("edit/delete buffer intents pinned to the loop-start snapshot (C2/C4)", () => {
  test("deleteLast buffers a deleteLast intent with the snapshot id", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    const res = await run(tools.deleteLast, {});
    expect(res).toMatchObject({ ok: true, deleted: { amount: "₱180.00", category: "Transport" } });
    expect(drain()).toEqual([{ type: "deleteLast", userId: "user-1", targetId: "tx-last" }]);
  });

  test("deleteLast with no snapshot returns error and buffers nothing", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: null });
    const res = await run(tools.deleteLast, {});
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("editLast buffers a patch pinned to the snapshot id and projects the reply", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    const res = await run(tools.editLast, { amount: "200" });
    expect(res).toMatchObject({ ok: true, updated: { amount: "₱200.00", category: "Transport" } });
    expect(drain()).toEqual([
      { type: "editLast", userId: "user-1", targetId: "tx-last", patch: { amountCentavos: 20000 } },
    ]);
  });

  test("editLast can clear a note with an empty string (L3)", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    const res = await run(tools.editLast, { note: "" });
    expect(res.ok).toBe(true);
    const writes = drain();
    expect(writes).toEqual([
      { type: "editLast", userId: "user-1", targetId: "tx-last", patch: { note: "" } },
    ]);
  });

  test("editLast with no fields is an error", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    const res = await run(tools.editLast, {});
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});

describe("same-turn log → edit → delete reflects post-edit values (L4)", () => {
  test("'grab 180, make it 200, delete that' confirms ₱200, not ₱180", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    await run(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await run(tools.editLast, { amount: "200" });
    const res = await run(tools.deleteLast, {});
    // The confirmation must echo the edited amount, matching what flushWrites stored then removed.
    expect(res).toMatchObject({ ok: true, deleted: { amount: "₱200.00", category: "Transport" } });
    const writes = drain();
    // Sequence: expense, editLast(same-turn), deleteLast(same-turn) — none target history.
    expect(writes.map((w) => w.type)).toEqual(["expense", "editLast", "deleteLast"]);
    expect(writes[2]).toEqual({ type: "deleteLast", userId: "user-1", targetSameTurn: true });
  });

  test("same-turn category edit then delete confirms the new category", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    await run(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await run(tools.editLast, { category: "Food" });
    const res = await run(tools.deleteLast, {});
    expect(res).toMatchObject({ ok: true, deleted: { category: "Food" } });
    drain();
  });
});

describe("same-message log-then-correct targets the just-logged entry (Risk 1)", () => {
  test("'grab 180, no make it 200' edits the same-turn log, not the snapshot", async () => {
    // Snapshot is an OLDER historical row; the correction must NOT clobber it.
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    await run(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    const res = await run(tools.editLast, { amount: "200" });
    expect(res).toMatchObject({ ok: true, updated: { amount: "₱200.00", category: "Transport" } });
    const writes = drain();
    expect(writes).toEqual([
      {
        type: "expense",
        userId: "user-1",
        amountCentavos: 18000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
      {
        type: "editLast",
        userId: "user-1",
        targetSameTurn: true,
        patch: { amountCentavos: 20000 },
      },
    ]);
    // Crucially: NO targetId pointing at the old snapshot row.
    expect(writes[1]).not.toHaveProperty("targetId");
  });

  test("'jollibee 250, scratch that' deletes the same-turn log, not the snapshot", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    await run(tools.logExpense, { amount: "250", category: "Food", note: "jollibee" });
    const res = await run(tools.deleteLast, {});
    expect(res).toMatchObject({ ok: true, deleted: { amount: "₱250.00", category: "Food" } });
    const writes = drain();
    expect(writes[1]).toEqual({ type: "deleteLast", userId: "user-1", targetSameTurn: true });
  });

  test("edit with NO same-turn log still pins the snapshot id (cross-turn correction)", async () => {
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    await run(tools.editLast, { amount: "200" });
    expect(drain()).toEqual([
      { type: "editLast", userId: "user-1", targetId: "tx-last", patch: { amountCentavos: 20000 } },
    ]);
  });

  test("editLast after a goalContribution in-buffer targets same-turn (no targetId)", async () => {
    // Build a context whose buffer already contains a goalContribution, then editLast.
    const { addWrite, peek, drain } = createWriteBuffer();
    const tools = buildTools({
      userId: "user-1",
      timezone: "Asia/Manila",
      today: "2026-06-11",
      lastTransaction: sampleLast, // older historical row that must NOT be touched
      memories: [],
      addWrite,
      peekWrites: peek,
    });
    // Simulate contributeToGoal having buffered its intent earlier this turn:
    addWrite({
      type: "goalContribution",
      userId: "user-1",
      goalId: "goal-1",
      amountCentavos: 200000,
      localDate: "2026-06-11",
    });
    const res = await run(tools.editLast, { amount: "3000" });
    expect(res).toMatchObject({ ok: true, updated: { amount: "₱3,000.00" } });
    const writes = drain();
    const edit = writes.find((w) => w.type === "editLast");
    expect(edit).toEqual({
      type: "editLast",
      userId: "user-1",
      targetSameTurn: true,
      patch: { amountCentavos: 300000 },
    });
    expect(edit).not.toHaveProperty("targetId");
  });

  test("log then same-turn delete then edit does NOT fall through to history", async () => {
    // Contrived "grab 180, scratch that, make it 300": after the same-turn delete there is no
    // live row; the edit must be a no-op, never touching the historical snapshot.
    const { tools, drain } = ctxWithBuffer({ lastTransaction: sampleLast });
    await run(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await run(tools.deleteLast, {});
    const res = await run(tools.editLast, { amount: "300" });
    expect(res.ok).toBe(false);
    const writes = drain();
    // No editLast intent that targets the historical snapshot.
    expect(writes.some((w) => w.type === "editLast")).toBe(false);
  });
});

describe("setBudget buffers a budget intent (Wave 3)", () => {
  test("'budget 5k for food' buffers setBudget", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.setBudget, { category: "Food", monthlyLimit: "5k" });
    expect(res).toMatchObject({ ok: true, category: "Food", monthlyLimit: "₱5,000.00" });
    expect(drain()).toEqual([
      { type: "setBudget", userId: "user-1", category: "Food", monthlyLimitCentavos: 500000 },
    ]);
  });
});

describe("backdating: logExpense/logIncome accept an optional date", () => {
  test("logExpense with a valid past date buffers that localDate", async () => {
    const { tools, drain } = ctxWithBuffer(); // ctx.today = 2026-06-11
    const res = await run(tools.logExpense, {
      amount: "800",
      category: "Food",
      note: "grocery",
      date: "2026-06-09",
    });
    expect(res).toMatchObject({ ok: true, date: "2026-06-09" });
    expect(drain()[0]).toMatchObject({
      type: "expense",
      amountCentavos: 80000,
      localDate: "2026-06-09",
    });
  });

  test("omitting date logs to today (ctx.today)", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.logExpense, { amount: "180", category: "Transport" });
    expect(drain()[0]).toMatchObject({ localDate: "2026-06-11" });
  });

  test("a future date is rejected and buffers nothing", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.logExpense, {
      amount: "180",
      category: "Food",
      date: "2026-06-20",
    });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("a non-calendar date is rejected", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.logIncome, { amount: "25k", date: "2026-02-30" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("logIncome backdates too", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.logIncome, { amount: "25k", note: "sweldo", date: "2026-05-30" });
    expect(res).toMatchObject({ ok: true, date: "2026-05-30" });
    expect(drain()[0]).toMatchObject({ type: "income", localDate: "2026-05-30" });
  });
});

describe("removeBudget buffers a removeBudget intent", () => {
  test("'drop the food budget' buffers removeBudget(Food)", async () => {
    const { tools, drain } = ctxWithBuffer();
    const res = await run(tools.removeBudget, { category: "Food" });
    expect(res).toMatchObject({ ok: true, removed: "Food" });
    expect(drain()).toEqual([{ type: "removeBudget", userId: "user-1", category: "Food" }]);
  });

  test("unknown category coerces to Other", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.removeBudget, { category: "Nonsense" });
    expect(drain()[0]).toMatchObject({ type: "removeBudget", category: "Other" });
  });
});

describe("memory tools buffer intents / read from context", () => {
  test("remember buffers a typed saveMemory intent", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.remember, { fact: "payday is the 15th", kind: "payday" });
    expect(drain()).toEqual([
      { type: "saveMemory", userId: "user-1", content: "payday is the 15th", kind: "payday" },
    ]);
  });

  test("forgetMemory buffers a forget intent", async () => {
    const { tools, drain } = ctxWithBuffer();
    await run(tools.forgetMemory, { match: "payday" });
    expect(drain()).toEqual([{ type: "forgetMemory", userId: "user-1", match: "payday" }]);
  });

  test("listMemory reads from context without buffering", async () => {
    const { tools, drain } = ctxWithBuffer({ memories: ["likes milk tea", "payday 15th"] });
    const res = (await run(tools.listMemory, {})) as unknown as { remembered: string[] };
    expect(res.remembered).toEqual(["likes milk tea", "payday 15th"]);
    expect(drain()).toHaveLength(0);
  });
});
