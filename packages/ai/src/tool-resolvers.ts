import { monthAnchor, validateLogDate } from "@repo/shared/time";

export type ResolvedLogDate = { ok: true; date: string } | { ok: false; error: string };

export function resolveLogDate(input: string | undefined, today: string): ResolvedLogDate {
  if (input === undefined) return { ok: true, date: today };
  const result = validateLogDate(input, new Date(`${today}T12:00:00Z`));
  return result.ok ? { ok: true, date: result.date } : { ok: false, error: result.reason };
}

export function resolveMonthAt(month: string | undefined): {
  at: Date | undefined;
  label: string | null;
} {
  if (month === undefined) return { at: undefined, label: null };
  const anchor = monthAnchor(month);
  return anchor ? { at: anchor, label: month } : { at: undefined, label: null };
}
