import { describe, expect, test } from "bun:test";
import { errInfo } from "./log";

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
