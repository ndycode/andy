import { beforeEach, describe, expect, test } from "bun:test";
import { handleInbound } from "./handler";
import { callCount, EXPENSE, type HandlerCall, handlerDeps, PHONE } from "./handler-test-harness";

let calls: HandlerCall[];
beforeEach(() => {
  calls = [];
});

describe("handleInbound — post-flush and failure boundaries", () => {
  test("a post-flush reply-send failure is swallowed — no misleading failure reply about saved data", async () => {
    // Data is committed; the reply send fails. Must NOT throw and must NOT escalate to the generic
    // failure reply (which would tell the user 'something went wrong' about data that WAS saved).
    await expect(
      handleInbound(
        PHONE,
        "grab 180",
        "m1",
        handlerDeps(calls, { writes: [EXPENSE], sendThrows: true }),
      ),
    ).resolves.toBeUndefined();
    expect(callCount(calls, "sendMessage")).toBe(1);
  });

  test("a post-flush budget-reaction failure is logged while the saved reply still sends", async () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (line?: unknown) => {
      errors.push(String(line));
    };

    try {
      await expect(
        handleInbound(
          PHONE,
          "grab 180",
          "m1",
          handlerDeps(calls, {
            writes: [EXPENSE],
            budgetStatusesThrows: new Error("budget status unavailable"),
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }

    expect(callCount(calls, "flushWrites")).toBe(1);
    expect(callCount(calls, "budgetStatusesFor")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(calls.find((call) => call.fn === "sendMessage")?.args[1]).toBe("logged ₱180 transport");
    expect(errors.some((line) => line.includes('"event":"inbound.budget_reaction_failed"'))).toBe(
      true,
    );
  });

  test("a PRE-flush agent failure sends the friendly failure reply (outer catch)", async () => {
    await handleInbound(
      PHONE,
      "grab 180",
      "m1",
      handlerDeps(calls, { agentThrows: new Error("503 service unavailable") }),
    );
    expect(callCount(calls, "flushWrites")).toBe(0);
    expect(callCount(calls, "sendMessage")).toBe(1);
  });

  test("a non-Error PRE-flush agent failure is rethrown instead of normalized", async () => {
    const failure = { reason: "bad-agent-value" } as const;

    await expect(
      handleInbound(PHONE, "grab 180", "m1", handlerDeps(calls, { agentThrows: failure })),
    ).rejects.toBe(failure);
    expect(callCount(calls, "flushWrites")).toBe(0);
    expect(callCount(calls, "sendMessage")).toBe(0);
  });

  test("a PRE-flush failure-reply send failure is logged without throwing", async () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (line?: unknown) => {
      errors.push(String(line));
    };

    try {
      await expect(
        handleInbound(
          PHONE,
          "grab 180",
          "m1",
          handlerDeps(calls, {
            agentThrows: new Error("503 service unavailable"),
            sendThrows: true,
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }

    expect(callCount(calls, "flushWrites")).toBe(0);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(errors.some((line) => line.includes('"event":"inbound.error"'))).toBe(true);
    expect(
      errors.some((line) => line.includes('"event":"inbound.failure_reply_send_failed"')),
    ).toBe(true);
  });

  test("a non-Error post-flush reply-send failure is rethrown", async () => {
    const failure = { reason: "bad-reply-send" } as const;

    await expect(
      handleInbound(
        PHONE,
        "grab 180",
        "m1",
        handlerDeps(calls, { writes: [EXPENSE], sendThrows: failure }),
      ),
    ).rejects.toBe(failure);
    expect(callCount(calls, "flushWrites")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
  });

  test("a non-Error failure-reply send failure is rethrown", async () => {
    const sendFailure = { reason: "bad-failure-reply-send" } as const;

    await expect(
      handleInbound(
        PHONE,
        "grab 180",
        "m1",
        handlerDeps(calls, {
          agentThrows: new Error("503 service unavailable"),
          sendThrows: sendFailure,
        }),
      ),
    ).rejects.toBe(sendFailure);
    expect(callCount(calls, "flushWrites")).toBe(0);
    expect(callCount(calls, "sendMessage")).toBe(1);
  });

  test("a non-Error post-commit effect failure is logged without throwing", async () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (line?: unknown) => {
      errors.push(String(line));
    };
    const failure = { reason: "bad-tapback" } as const;

    try {
      await expect(
        handleInbound(PHONE, "grab 180", "m1", {
          ...handlerDeps(calls, { writes: [EXPENSE] }),
          sendReaction: async (...args) => {
            calls.push({ fn: "sendReaction", args });
            throw failure;
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }

    expect(callCount(calls, "flushWrites")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(callCount(calls, "sendReaction")).toBe(1);
    expect(errors.some((line) => line.includes('"event":"inbound.post_commit_failed"'))).toBe(true);
  });
});
