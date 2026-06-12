import type { LastTransaction, WriteIntent } from "@repo/db";

/**
 * Per-request context injected into every tool's execute (plain closure, server-controlled).
 * Tools NEVER receive userId from the model — identity is server-side only.
 * Write-tools call addWrite() to buffer an intent; nothing touches the DB during the agent run.
 */
export interface ToolContext {
  userId: string;
  timezone: string;
  /** localDate (YYYY-MM-DD) for "today" in the user's timezone, computed at request start. */
  today: string;
  /**
   * Snapshot of the user's most-recent transaction at agent-loop start (or null).
   * edit/delete tools pin its id so a 429-retry replay can't target a different row,
   * and use it to report the projected result without a DB read mid-loop.
   */
  lastTransaction: LastTransaction | null;
  /** Memories recalled at loop start, so listMemory answers without a DB read mid-loop. */
  memories: string[];
  addWrite: (intent: WriteIntent) => void;
  /**
   * Read the writes buffered so far THIS turn. edit/delete tools use this so a correction that
   * follows a log in the SAME message ("grab 180, no make it 200") targets the just-logged entry
   * instead of an older historical row.
   */
  peekWrites: () => readonly WriteIntent[];
}

/** Collects buffered writes for one request. */
export function createWriteBuffer(): {
  addWrite: (intent: WriteIntent) => void;
  peek: () => readonly WriteIntent[];
  drain: () => WriteIntent[];
} {
  const buffer: WriteIntent[] = [];
  return {
    addWrite: (intent) => buffer.push(intent),
    peek: () => buffer,
    drain: () => buffer.slice(),
  };
}
