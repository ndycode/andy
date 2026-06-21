import { describe, expect, test } from "bun:test";
import * as ai from "./index";

describe("ai package root boundary", () => {
  test("exports the runtime entrypoints used by the API app", () => {
    expect(typeof ai.runAgent).toBe("function");
    expect(typeof ai.composeProactive).toBe("function");
  });

  test("does not expose model, prompt, buffer, or tool-builder internals", () => {
    expect("MODEL_ID" in ai).toBe(false);
    expect("SYSTEM_PROMPT" in ai).toBe(false);
    expect("createWriteBuffer" in ai).toBe(false);
    expect("buildTools" in ai).toBe(false);
  });
});
