import { localDate } from "./local-time";

export type DateResult = { ok: true; date: string } | { ok: false; reason: string };

/**
 * Validate a YYYY-MM-DD as a real, past-or-today Manila calendar date — for backdated logging.
 * The LLM resolves natural-language dates against the prompt's <today> block; this hardens the
 * structured result by rejecting malformed input, non-calendar dates, future dates, and very old
 * years that are almost certainly typos.
 */
export function validateLogDate(input: string, now: Date = new Date()): DateResult {
  const parsed = parseCalendarDate(input);
  if (!parsed.ok) return parsed;

  const today = localDate(now);
  if (parsed.date > today) return { ok: false, reason: "can't log a future date" };
  if (parsed.year < Number(today.slice(0, 4)) - 5) {
    return { ok: false, reason: "that's too far back" };
  }
  return { ok: true, date: parsed.date };
}

/**
 * Validate a YYYY-MM-DD as a real calendar date in either direction. Used by goal create/edit so a
 * raw natural-language date can never reach the DB and later render as "Invalid Date"/NaN pace.
 */
export function validateCalendarDate(input: string): DateResult {
  const parsed = parseCalendarDate(input);
  return parsed.ok ? { ok: true, date: parsed.date } : parsed;
}

type ParsedDate =
  | { ok: true; date: string; year: number }
  | { ok: false; reason: "date must be YYYY-MM-DD" | "not a real date" };

function parseCalendarDate(input: string): ParsedDate {
  const s = input.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false, reason: "date must be YYYY-MM-DD" };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
    return { ok: false, reason: "not a real date" };
  }
  return { ok: true, date: s, year: y };
}
