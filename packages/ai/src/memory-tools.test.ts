import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { buildMemoryTools } from "./memory-tools";
import { runTool } from "./tool-test-harness";

describe("buildMemoryTools module boundary", () => {
  test("builds the memory tool group in the public tool order", () => {
    expect(Object.keys(buildMemoryTools(ctx()))).toEqual([
      "remember",
      "forgetMemory",
      "listMemory",
    ]);
  });

  test("owns memory behavior outside the high-level tools suite", () => {
    const source = readFileSync(new URL("./tools.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("memory tools buffer intents / read from context");
  });

  test("executes remember through the memory tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildMemoryTools(toolCtx);

    const result = await runTool(tools.remember, {
      fact: "payday is the 15th",
      kind: "payday",
    });

    expect(result).toEqual({ ok: true, remembered: "payday is the 15th" });
    expect(drain()).toEqual([
      { type: "saveMemory", userId: "user-1", content: "payday is the 15th", kind: "payday" },
    ]);
  });

  test("executes forgetMemory through the memory tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildMemoryTools(toolCtx);

    const result = await runTool(tools.forgetMemory, { match: "payday" });

    expect(result).toEqual({ ok: true, forgetting: "payday" });
    expect(drain()).toEqual([{ type: "forgetMemory", userId: "user-1", match: "payday" }]);
  });

  test("listMemory accepts an optional query for specific memory reads", () => {
    const source = readFileSync(new URL("./memory-tools.ts", import.meta.url), "utf8");

    expect(source).toContain("query:");
    expect(source).toContain("pass the user's question as query");
  });
});
