import { describe, expect, test } from "bun:test";
import { errInfo, log } from "./log";

describe("log emit (total logger)", () => {
  function capture(fn: () => void): string[] {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (l?: unknown) => {
      lines.push(String(l));
    };
    try {
      fn();
    } finally {
      console.log = realLog;
    }
    return lines;
  }

  test("never throws on an unserializable field; emits a safe fallback line", () => {
    let lines: string[] = [];
    // BigInt is not JSON-serializable — JSON.stringify would throw and (pre-fix) crash the caller.
    expect(() => {
      lines = capture(() => log.info("test.event", { big: 10n }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.event).toBe("test.event");
    expect(parsed.logError).toBe("unserializable fields dropped");
  });

  test("serializes normal fields into one structured line", () => {
    const lines = capture(() => log.info("ok.event", { a: 1, b: "x" }));
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      event: "ok.event",
      a: 1,
      b: "x",
    });
  });
});

describe("errInfo", () => {
  test("default is terse: name + message, no stack", () => {
    const r = errInfo(new Error("boom"));
    expect(r).toEqual({ name: "Error", message: "boom" });
    expect("stack" in r).toBe(false);
  });

  test("opt-in stack includes the stack trace", () => {
    const r = errInfo(new Error("boom"), { stack: true });
    expect(r.name).toBe("Error");
    expect(r.message).toBe("boom");
    expect(typeof r.stack).toBe("string");
    expect(r.stack).toContain("boom");
  });

  test("custom error name is preserved", () => {
    const e = Object.assign(new Error("nope"), { name: "TimeoutError" });
    expect(errInfo(e)).toMatchObject({ name: "TimeoutError", message: "nope" });
  });

  test("non-Error thrown value is stringified safely", () => {
    expect(errInfo("just a string")).toEqual({ name: "NonError", message: "just a string" });
    expect(errInfo({ weird: true }).name).toBe("NonError");
  });

  test("stack opt-in on a non-Error is still terse (no stack field)", () => {
    const r = errInfo("oops", { stack: true });
    expect(r).toEqual({ name: "NonError", message: "oops" });
  });
});
