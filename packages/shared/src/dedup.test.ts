import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contentDedupKey } from "./dedup";

describe("contentDedupKey — content-hash dedup fallback", () => {
  const t = new Date("2026-06-12T04:30:20Z");

  test("source remains text-diffable without literal NUL bytes", () => {
    const source = readFileSync(new URL("./dedup.ts", import.meta.url));

    expect(source.includes(0)).toBe(false);
  });

  test("same phone+text in the same minute → same key (a redelivery dedups)", () => {
    const a = contentDedupKey("+639171234567", "grab 180", t);
    const b = contentDedupKey("+639171234567", "grab 180", new Date("2026-06-12T04:30:55Z"));
    expect(a).toBe(b);
  });

  test("trims whitespace so trivial differences still collide", () => {
    expect(contentDedupKey("+639171234567", "grab 180", t)).toBe(
      contentDedupKey("+639171234567", "  grab 180  ", t),
    );
  });

  test("different text → different key", () => {
    expect(contentDedupKey("+639171234567", "grab 180", t)).not.toBe(
      contentDedupKey("+639171234567", "grab 200", t),
    );
  });

  test("different phone → different key", () => {
    expect(contentDedupKey("+639171234567", "grab 180", t)).not.toBe(
      contentDedupKey("+639170000000", "grab 180", t),
    );
  });

  test("next minute → different key (intentional repeat goes through)", () => {
    const a = contentDedupKey("+639171234567", "grab 180", t);
    const b = contentDedupKey("+639171234567", "grab 180", new Date("2026-06-12T04:31:20Z"));
    expect(a).not.toBe(b);
  });

  test("has a stable channel prefix", () => {
    expect(contentDedupKey("+639171234567", "grab 180", t)).toMatch(/^ch_[0-9a-f]{32}$/);
  });
});
