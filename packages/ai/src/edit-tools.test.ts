import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { LastTransaction } from "@repo/db";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { buildEditTools } from "./edit-tools";
import { runTool } from "./tool-test-harness";

const sampleLast: LastTransaction = {
  id: "tx-last",
  kind: "expense",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  goalId: null,
};

function editToolCtx(opts: { lastTransaction?: LastTransaction | null } = {}) {
  const { ctx: context, drain } = toolContextBuffer(opts);
  const tools = buildEditTools(context);

  return { tools, drain };
}

describe("buildEditTools module boundary", () => {
  test("builds the edit/delete tool group in the public tool order", () => {
    expect(Object.keys(buildEditTools(ctx()))).toEqual(["deleteLast", "editLast"]);
  });

  test("owns snapshot edit/delete behavior outside the high-level tools suite", () => {
    const source = readFileSync(new URL("./tools.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("edit/delete buffer intents pinned to the loop-start snapshot");
  });
});

describe("snapshot edit/delete tools", () => {
  test("deleteLast buffers a deleteLast intent with the snapshot id", async () => {
    const { tools, drain } = editToolCtx({ lastTransaction: sampleLast });

    const res = await runTool(tools.deleteLast, {});

    expect(res).toMatchObject({ ok: true, deleted: { amount: "₱180.00", category: "Transport" } });
    expect(drain()).toEqual([{ type: "deleteLast", userId: "user-1", targetId: "tx-last" }]);
  });

  test("deleteLast with no snapshot returns error and buffers nothing", async () => {
    const { tools, drain } = editToolCtx({ lastTransaction: null });

    const res = await runTool(tools.deleteLast, {});

    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("editLast buffers a patch pinned to the snapshot id and projects the reply", async () => {
    const { tools, drain } = editToolCtx({ lastTransaction: sampleLast });

    const res = await runTool(tools.editLast, { amount: "200" });

    expect(res).toMatchObject({ ok: true, updated: { amount: "₱200.00", category: "Transport" } });
    expect(drain()).toEqual([
      { type: "editLast", userId: "user-1", targetId: "tx-last", patch: { amountCentavos: 20000 } },
    ]);
  });

  test("editLast can clear a note with an empty string", async () => {
    const { tools, drain } = editToolCtx({ lastTransaction: sampleLast });

    const res = await runTool(tools.editLast, { note: "" });

    expect(res.ok).toBe(true);
    expect(drain()).toEqual([
      { type: "editLast", userId: "user-1", targetId: "tx-last", patch: { note: "" } },
    ]);
  });

  test("editLast with no fields is an error", async () => {
    const { tools, drain } = editToolCtx({ lastTransaction: sampleLast });

    const res = await runTool(tools.editLast, {});

    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});
