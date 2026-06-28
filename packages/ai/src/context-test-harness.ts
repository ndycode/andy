import type { LastTransaction } from "@repo/db";
import { createWriteBuffer, type ToolContext } from "./context";

type ToolContextOpts = {
  userId?: string;
  timezone?: string;
  today?: string;
  inboundText?: string;
  lastTransaction?: LastTransaction | null;
};

function normalizeToolContextOpts(opts: ToolContextOpts | string = {}): ToolContextOpts {
  return typeof opts === "string" ? { today: opts } : opts;
}

export function toolContext(opts: ToolContextOpts | string = {}): ToolContext {
  return toolContextBuffer(opts).ctx;
}

export function toolContextBuffer(opts: ToolContextOpts | string = {}) {
  const normalized = normalizeToolContextOpts(opts);
  const { addWrite, peek, drain } = createWriteBuffer();
  const ctx: ToolContext = {
    userId: normalized.userId ?? "user-1",
    timezone: normalized.timezone ?? "Asia/Manila",
    today: normalized.today ?? "2026-06-11",
    inboundText: normalized.inboundText,
    lastTransaction: normalized.lastTransaction ?? null,
    addWrite,
    peekWrites: peek,
  };

  return { ctx, addWrite, peek, drain };
}
