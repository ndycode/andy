import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { LastTransaction } from "@repo/db";
import { toolContext as ctx } from "./context-test-harness";
import { buildTools } from "./tools";

const { runTool, toolCtx } = await import("./tool-test-harness");

const sampleLast: LastTransaction = {
  id: "tx-last",
  kind: "expense",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  goalId: null,
};

describe("same-turn log → edit → delete reflects post-edit values (L4)", () => {
  test("'grab 180, make it 200, delete that' confirms ₱200, not ₱180", async () => {
    const { tools, drain } = toolCtx({ lastTransaction: sampleLast });
    await runTool(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await runTool(tools.editLast, { amount: "200" });
    const res = await runTool(tools.deleteLast, {});
    // The confirmation must echo the edited amount, matching what flushWrites stored then removed.
    expect(res).toMatchObject({ ok: true, deleted: { amount: "₱200.00", category: "Transport" } });
    const writes = drain();
    // Sequence: expense, editLast(same-turn), deleteLast(same-turn) — none target history.
    expect(writes.map((w) => w.type)).toEqual(["expense", "editLast", "deleteLast"]);
    expect(writes[2]).toEqual({ type: "deleteLast", userId: "user-1", targetSameTurn: true });
  });

  test("same-turn category edit then delete confirms the new category", async () => {
    const { tools, drain } = toolCtx({ lastTransaction: sampleLast });
    await runTool(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await runTool(tools.editLast, { category: "Food" });
    const res = await runTool(tools.deleteLast, {});
    expect(res).toMatchObject({ ok: true, deleted: { category: "Food" } });
    drain();
  });
});

describe("buildTools profile routing", () => {
  test("keeps the full public surface by default", () => {
    expect(Object.keys(buildTools(ctx()))).toContain("setBudget");
    expect(Object.keys(buildTools(ctx()))).toContain("searchHistory");
    expect(Object.keys(buildTools(ctx()))).toContain("addRecurringBill");
  });

  test("narrows the runtime tool map for simple log and read profiles", () => {
    expect(Object.keys(buildTools(ctx(), {}, "log"))).toEqual([
      "logExpense",
      "logIncome",
      "editLast",
      "deleteLast",
    ]);
    expect(Object.keys(buildTools(ctx(), {}, "readBasic"))).toEqual([
      "getSpending",
      "getPeriodSpending",
      "getOverview",
      "getCategoryBreakdown",
      "getRecent",
    ]);
    expect(Object.keys(buildTools(ctx(), {}, "read"))).toEqual([
      "getSpending",
      "getPeriodSpending",
      "getOverview",
      "getCategoryBreakdown",
      "getRecent",
      "insights",
      "compareSpending",
      "searchHistory",
      "getSpendingPace",
    ]);
  });

  test("chat profile exposes no tools for true small talk", () => {
    expect(Object.keys(buildTools(ctx(), {}, "chat"))).toEqual([]);
  });

  test("narrow profiles build only their selected tool groups", () => {
    const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");

    expect(source).toContain('case "chat":');
    expect(source).toContain("return narrowTools({});");
    expect(source).toContain("return narrowTools(buildLogToolProfile(ctx, deps));");
    expect(source).toContain("return narrowTools(buildBasicReadTools(ctx));");
    expect(source).toContain("return narrowTools(buildReadToolProfile(ctx));");
    expect(source).not.toContain("pickProfileTools");
    expect(source).not.toContain("TOOL_PROFILE_KEYS");
  });
});

describe("same-message log-then-correct targets the just-logged entry (Risk 1)", () => {
  test("'grab 180, no make it 200' edits the same-turn log, not the snapshot", async () => {
    // Snapshot is an OLDER historical row; the correction must NOT clobber it.
    const { tools, drain } = toolCtx({ lastTransaction: sampleLast });
    await runTool(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    const res = await runTool(tools.editLast, { amount: "200" });
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
    const { tools, drain } = toolCtx({ lastTransaction: sampleLast });
    await runTool(tools.logExpense, { amount: "250", category: "Food", note: "jollibee" });
    const res = await runTool(tools.deleteLast, {});
    expect(res).toMatchObject({ ok: true, deleted: { amount: "₱250.00", category: "Food" } });
    const writes = drain();
    expect(writes[1]).toEqual({ type: "deleteLast", userId: "user-1", targetSameTurn: true });
  });

  test("edit with NO same-turn log still pins the snapshot id (cross-turn correction)", async () => {
    const { tools, drain } = toolCtx({ lastTransaction: sampleLast });
    await runTool(tools.editLast, { amount: "200" });
    expect(drain()).toEqual([
      { type: "editLast", userId: "user-1", targetId: "tx-last", patch: { amountCentavos: 20000 } },
    ]);
  });

  test("editLast after a goalContribution in-buffer targets same-turn (no targetId)", async () => {
    // Build a context whose buffer already contains a goalContribution, then editLast.
    const { tools, addWrite, drain } = toolCtx({ lastTransaction: sampleLast });
    // Simulate contributeToGoal having buffered its intent earlier this turn:
    addWrite({
      type: "goalContribution",
      userId: "user-1",
      goalId: "goal-1",
      amountCentavos: 200000,
      localDate: "2026-06-11",
    });
    const res = await runTool(tools.editLast, { amount: "3000" });
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
    const { tools, drain } = toolCtx({ lastTransaction: sampleLast });
    await runTool(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await runTool(tools.deleteLast, {});
    const res = await runTool(tools.editLast, { amount: "300" });
    expect(res.ok).toBe(false);
    const writes = drain();
    // No editLast intent that targets the historical snapshot.
    expect(writes.some((w) => w.type === "editLast")).toBe(false);
  });
});
