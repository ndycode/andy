import { type Category, coerceExpenseCategory } from "@repo/shared/categories";
import { log } from "@repo/shared/log";
import type { RunResult } from "./agent";
import type { AgentBaseContext } from "./agent-context";
import { createWriteBuffer } from "./context";
import { logExpense, logIncome } from "./log-actions";

const AMOUNT_GLOBAL_RE = /(?:₱|php\s*)?\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b/gi;
const DATE_OR_MIXED_TURN_RE =
  /\b(yesterday|tomorrow|ago|last|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|actually|no wait|make it|change it|delete|undo|remember|budget|goal|recurring|remind|every)\b|[,;]|(?:^|\s)(?:and|then|also)(?:\s|$)/i;
const FILLER_WORDS = new Set([
  "spent",
  "paid",
  "bought",
  "got",
  "on",
  "for",
  "at",
  "sa",
  "ng",
  "the",
  "my",
  "a",
  "an",
]);
const INCOME_RE = /\b(salary|sweldo|income|paycheck|wage|wages|payment received)\b/i;

type FastLogInput =
  | {
      kind: "expense";
      amount: string;
      note: string;
      category: Category;
    }
  | {
      kind: "income";
      amount: string;
      note: string;
    };

export function parseFastLogInput(text: string): FastLogInput | null {
  if (DATE_OR_MIXED_TURN_RE.test(text)) return null;
  const amounts = [...text.matchAll(AMOUNT_GLOBAL_RE)].map((match) => match[0].trim());
  if (amounts.length !== 1) return null;

  const note = text
    .replace(AMOUNT_GLOBAL_RE, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word))
    .join(" ")
    .trim();
  if (!note) return null;

  const amount = amounts[0];
  if (amount === undefined) return null;
  if (INCOME_RE.test(note)) return { kind: "income", amount, note };

  const category = coerceExpenseCategory("Other", note);
  if (category === "Other" || category === "Income") return null;
  return { kind: "expense", amount, note, category };
}

export async function tryFastLog(text: string, base: AgentBaseContext): Promise<RunResult | null> {
  const input = parseFastLogInput(text);
  if (!input) return null;

  const { addWrite, peek, drain } = createWriteBuffer();
  const ctx = { ...base, lastTransaction: null, addWrite, peekWrites: peek };

  if (input.kind === "income") {
    const result = await logIncome(ctx, { amount: input.amount, note: input.note });
    if ("error" in result) return null;
    const writes = drain();
    log.info("agent.fast_log", {
      userId: base.userId,
      kind: input.kind,
      writes: writes.length,
      category: "Income",
    });
    return { reply: `logged ${result.logged} income`, writes };
  }

  const result = await logExpense(ctx, {
    amount: input.amount,
    category: input.category,
    note: input.note,
  });
  if ("error" in result) return null;

  const writes = drain();
  const reply = `logged ${result.logged} on ${result.category.toLowerCase()}${duplicateNote(
    result,
    input.note,
  )}`;
  log.info("agent.fast_log", {
    userId: base.userId,
    kind: input.kind,
    writes: writes.length,
    category: input.kind === "expense" ? result.category : "Income",
  });
  return { reply, writes };
}

function duplicateNote(
  result: { possibleDuplicate?: boolean; logged: string },
  note: string,
): string {
  return result.possibleDuplicate
    ? `. heads up, i already have an identical ${result.logged} ${note} today, say 'delete that' if it's a dupe`
    : "";
}
