import type { GoalRow, WriteIntent } from "@repo/db";
import { coerceExpenseCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";

export interface FastPathDeps {
  getMonthOverview(
    userId: string,
    at?: Date,
  ): Promise<{ income: number; expense: number; net: number }>;
  getSpendingByCategory(userId: string, at?: Date): Promise<{ category: string; total: number }[]>;
  findGoalByName(userId: string, name: string): Promise<GoalRow | null>;
  listGoals(userId: string): Promise<GoalRow[]>;
}

export interface FastPathContext {
  userId: string;
  today: string;
}

export interface FastPathResult {
  reply: string;
  writes: WriteIntent[];
}

type ExpenseEntry = {
  amountCentavos: number;
  note: string;
};

const SPEND_HINT =
  /\b(spent|paid|bought|got|log|logged|grab|milk\s*tea|milktea|iced\s*matcha|matcha|coffee|grocer(?:y|ies)|lunch|dinner|breakfast|snacks?|taxi|fare|gas|fuel|parking|toll)\b/i;
const QUESTION_START = /^\s*(how|what|why|when|can|should|could|would|do|did|is|are)\b/i;
const AMOUNT_TOKEN = "(?:₱|php\\s*)?\\d[\\d,]*(?:\\.\\d+)?\\s*[kKmM]?";

export async function tryFastPath(
  text: string,
  ctx: FastPathContext,
  deps: FastPathDeps,
): Promise<FastPathResult | null> {
  return (
    tryGreeting(text) ??
    tryFastExpense(text, ctx) ??
    tryPaydayMemory(text, ctx) ??
    tryCreateGoal(text, ctx) ??
    (await tryGoalContribution(text, ctx, deps)) ??
    (await tryMonthOverview(text, ctx, deps)) ??
    (await tryPaydayRunway(text, ctx, deps)) ??
    tryCasual(text)
  );
}

function tryGreeting(text: string): FastPathResult | null {
  if (!/^\s*(hi|hello|hey|yo)(?:\s+andy)?[!. ]*$/i.test(text)) return null;
  return { reply: "hi! how can i help with your money today?", writes: [] };
}

function tryFastExpense(text: string, ctx: FastPathContext): FastPathResult | null {
  if (QUESTION_START.test(text)) return null;
  if (!SPEND_HINT.test(text)) return null;

  const entries = parseExpenseEntries(text);
  if (entries.length === 0) return null;

  const writes: WriteIntent[] = entries.map((entry) => ({
    type: "expense",
    userId: ctx.userId,
    amountCentavos: entry.amountCentavos,
    category: coerceExpenseCategory("Other", entry.note),
    note: entry.note,
    localDate: ctx.today,
  }));
  const itemText = entries
    .map((entry) => `${formatCasualPHP(entry.amountCentavos)} ${entry.note}`)
    .join(" + ");
  const total = entries.reduce((sum, entry) => sum + entry.amountCentavos, 0);
  const tail = entries.length === 1 ? "" : ` ${formatCasualPHP(total)} total today.`;
  return { reply: `got it, logged ${itemText}.${tail}`, writes };
}

function parseExpenseEntries(text: string): ExpenseEntry[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\b(?:yo|hey|hi)\s+andy\b[,\s]*/g, "")
    .replace(/\b(?:today|huhu|haha|lol|btw|na|lang|pls|please)\b/g, " ")
    .replace(/^\s*(?:i\s+)?(?:spent|spend|paid|pay|bought|buy|got|log|logged)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const entries: ExpenseEntry[] = [];
  for (const rawPart of cleaned.split(/\s*(?:,|;|\+|&|\band\b|\bthen\b|\bplus\b)\s*/i)) {
    const part = rawPart.trim();
    if (!part) continue;
    const entry = parseExpensePart(part);
    if (!entry) return [];
    entries.push(entry);
    if (entries.length >= 6) break;
  }
  return entries;
}

function parseExpensePart(part: string): ExpenseEntry | null {
  const amountFirst = new RegExp(`^(${AMOUNT_TOKEN})\\s*(?:on|for|sa|at)?\\s+(.+)$`, "i");
  const noteFirst = new RegExp(`^(.+?)\\s+(${AMOUNT_TOKEN})$`, "i");
  const amountFirstMatch = part.match(amountFirst);
  const noteFirstMatch = amountFirstMatch ? null : part.match(noteFirst);
  const amountRaw = amountFirstMatch?.[1] ?? noteFirstMatch?.[2];
  const noteRaw = amountFirstMatch?.[2] ?? noteFirstMatch?.[1];
  if (!amountRaw || !noteRaw) return null;

  const amount = parseAmount(amountRaw);
  if (!amount.ok) return null;
  const note = cleanNote(noteRaw);
  if (!note) return null;
  return { amountCentavos: amount.centavos, note };
}

function cleanNote(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(?:on|for|sa|at)\s+/i, "")
    .replace(/\b(?:today|huhu|haha|lol|btw|na|lang|pls|please)\b/g, " ")
    .replace(/[^a-z0-9 /-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tryPaydayMemory(text: string, ctx: FastPathContext): FastPathResult | null {
  const lower = text.toLowerCase();
  if (!/\b(remember|get paid|payday|sweldo)\b/.test(lower)) return null;
  if (!/\b15(?:st|th)?\b/.test(lower) || !/\b30(?:th)?\b/.test(lower)) return null;

  const content = "Payday is every 15th and 30th.";
  return {
    reply: "locked in 🔒 i'll watch your runway between paydays.",
    writes: [{ type: "saveMemory", userId: ctx.userId, content, kind: "payday" }],
  };
}

function tryCreateGoal(text: string, ctx: FastPathContext): FastPathResult | null {
  const lower = text.toLowerCase();
  if (!/\b(save|saving)\b/.test(lower)) return null;

  const match = lower.match(
    new RegExp(`\\bsav(?:e|ing)\\s+(${AMOUNT_TOKEN})\\s+(?:for|towards?|to)\\s+(.+)$`, "i"),
  );
  if (!match?.[1] || !match[2]) return null;

  const amount = parseAmount(match[1]);
  if (!amount.ok) return null;

  const { nameRaw, deadlineRaw } = splitGoalDeadline(match[2]);
  const name = goalNameFromText(nameRaw);
  if (!name) return null;
  const targetDate = deadlineRaw ? deadlineFromText(deadlineRaw, ctx.today) : null;

  return {
    reply: `nice. "${name}" started 🎯 ${formatCasualPHP(amount.centavos)} target${targetDate ? ` by ${targetDate}` : ""}.`,
    writes: [
      {
        type: "createGoal",
        userId: ctx.userId,
        name,
        targetCentavos: amount.centavos,
        targetDate,
      },
    ],
  };
}

function splitGoalDeadline(raw: string): { nameRaw: string; deadlineRaw: string | null } {
  const match = raw.match(/^(.+?)\s+by\s+(.+)$/i);
  if (!match?.[1]) return { nameRaw: raw, deadlineRaw: null };
  return { nameRaw: match[1], deadlineRaw: match[2] ?? null };
}

function goalNameFromText(raw: string): string | null {
  const cleaned = raw
    .replace(/\b(?:a|an|the|fund|goal|trip|by|december|this|that|also|wanna|want|to)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\bjapan\b/.test(raw)) return "Japan fund";
  if (cleaned) return titleCase(`${cleaned} fund`);
  if (/\btrip\b/.test(raw)) return "Trip fund";
  return null;
}

function deadlineFromText(raw: string, today: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  const month = monthNumber(cleaned);
  if (!month) return null;
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const year = month >= currentMonth ? currentYear : currentYear + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;
}

async function tryGoalContribution(
  text: string,
  ctx: FastPathContext,
  deps: FastPathDeps,
): Promise<FastPathResult | null> {
  const lower = text.toLowerCase();
  if (!/\b(put|add|contribute)\b/.test(lower)) return null;

  const match = lower.match(
    new RegExp(
      `\\b(?:put|add|contribute)\\s+(${AMOUNT_TOKEN})\\s+(?:to|towards?|into|in)\\s+(.+)$`,
      "i",
    ),
  );
  if (!match?.[1] || !match[2]) return null;
  const amount = parseAmount(match[1]);
  if (!amount.ok) return null;

  const query = cleanGoalQuery(match[2]);
  const goal = await resolveGoalForContribution(ctx.userId, query, deps);
  if (!goal) return null;

  const saved = goal.savedCentavos + amount.centavos;
  const pct = Math.min(100, Math.round((saved / goal.targetCentavos) * 100));
  return {
    reply: `done ✅ ${formatCasualPHP(saved)} / ${formatCasualPHP(goal.targetCentavos)}. ${pct}% there, baby steps 🐣`,
    writes: [
      {
        type: "goalContribution",
        userId: ctx.userId,
        goalId: goal.id,
        amountCentavos: amount.centavos,
        localDate: ctx.today,
      },
    ],
  };
}

function cleanGoalQuery(raw: string): string {
  return raw
    .replace(/\b(?:na|please|pls|fund|goal)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveGoalForContribution(
  userId: string,
  query: string,
  deps: FastPathDeps,
): Promise<GoalRow | null> {
  if (query && !/^(it|that|there|this)$/.test(query)) {
    const named = await deps.findGoalByName(userId, query);
    if (named) return named;
  }
  const goals = await deps.listGoals(userId);
  return [...goals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

async function tryMonthOverview(
  text: string,
  ctx: FastPathContext,
  deps: FastPathDeps,
): Promise<FastPathResult | null> {
  const lower = text.toLowerCase();
  if (!/\b(this month|month)\b/.test(lower)) return null;
  if (!/\b(spent|spend|spending|how much)\b/.test(lower)) return null;

  const [overview, categories] = await Promise.all([
    deps.getMonthOverview(ctx.userId, dateFromLocalDate(ctx.today)),
    deps.getSpendingByCategory(ctx.userId, dateFromLocalDate(ctx.today)),
  ]);
  const top = categories[0];
  const topText = top
    ? ` ${top.category.toLowerCase()} is biggest at ${formatCasualPHP(top.total)}.`
    : "";
  return {
    reply: `${formatCasualPHP(overview.expense)} so far this month.${topText}`,
    writes: [],
  };
}

async function tryPaydayRunway(
  text: string,
  ctx: FastPathContext,
  deps: FastPathDeps,
): Promise<FastPathResult | null> {
  const lower = text.toLowerCase();
  if (!/\b(payday|runway|til pay|until pay)\b/.test(lower)) return null;

  const overview = await deps.getMonthOverview(ctx.userId, dateFromLocalDate(ctx.today));
  const days = daysUntilNextPayday(ctx.today);
  return {
    reply: `${days} day${days === 1 ? "" : "s"} til payday. ${formatCasualPHP(overview.expense)} logged this month. keep it tight and you're okay.`,
    writes: [],
  };
}

function tryCasual(text: string): FastPathResult | null {
  const lower = text.toLowerCase();
  if (/\b(don'?t expose|dont expose|expose me)\b/.test(lower)) {
    return { reply: "just saying 😭 still fixable tho.", writes: [] };
  }
  if (/\blocked in\b|\bi'?ll watch\b|\brunway\b/.test(lower)) {
    return { reply: "locked in 🔒 i'll keep an eye on it between paydays.", writes: [] };
  }
  return null;
}

function formatCasualPHP(centavos: number): string {
  return formatPHP(centavos).replace(/\.00$/, "");
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function monthNumber(value: string): number | null {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const idx = months.findIndex((month) => value.includes(month));
  return idx === -1 ? null : idx + 1;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateFromLocalDate(local: string): Date {
  return new Date(`${local}T00:00:00+08:00`);
}

function daysUntilNextPayday(today: string): number {
  const day = Number(today.slice(8, 10));
  if (day < 15) return 15 - day;
  if (day < 30) return 30 - day;
  return 15;
}
