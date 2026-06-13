/**
 * Fixed-offset local-time helpers. The app's single user lives in Asia/Manila (UTC+8, no DST), so
 * we shift by a deterministic offset rather than depending on host TZ database data — but the offset
 * is a parameter (defaulting to Manila) so other FIXED-OFFSET zones work without code changes.
 *
 * Scope note: this models fixed-offset zones only. Zones with DST (e.g. America/New_York) would need
 * a real tz library; that's intentionally out of scope until a non-fixed-offset user exists. The
 * default offset comes from APP_TIMEZONE_OFFSET_MINUTES (minutes east of UTC) or falls back to Manila;
 * per-call overrides accept an explicit `offsetMs` (see the `users.timezone` column for future
 * per-user resolution).
 */
export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Default offset for callers that don't specify one — overridable via APP_TIMEZONE_OFFSET_MINUTES. */
export const DEFAULT_OFFSET_MS = resolveDefaultOffsetMs();

function resolveDefaultOffsetMs(): number {
  // Env override (minutes east of UTC, e.g. 480 for UTC+8). Lets a deploy retarget the zone without
  // a code change. Invalid/unset → Manila. Read defensively: this module loads before env validation.
  const raw = typeof process !== "undefined" ? process.env?.APP_TIMEZONE_OFFSET_MINUTES : undefined;
  if (raw != null && raw.trim() !== "") {
    const mins = Number(raw);
    if (Number.isFinite(mins) && Math.abs(mins) <= 14 * 60) return mins * 60 * 1000;
  }
  return MANILA_OFFSET_MS;
}

/**
 * IANA-style zone label for the active timezone, surfaced to the agent prompt ("Today is … (label)").
 * Overridable via APP_TIMEZONE; defaults to Asia/Manila to match DEFAULT_OFFSET_MS. This is a display
 * label only — the actual date math uses the numeric offset above.
 */
export const APP_TIMEZONE: string =
  (typeof process !== "undefined" ? process.env?.APP_TIMEZONE?.trim() : undefined) || "Asia/Manila";

/** A Date shifted into local wall-clock for `offsetMs`, read via getUTC* accessors. */
function toLocal(d: Date, offsetMs: number): Date {
  return new Date(d.getTime() + offsetMs);
}

/** "YYYY-MM-DD" for the given instant in local time (default offset = Manila). */
export function localDate(at: Date = new Date(), offsetMs: number = DEFAULT_OFFSET_MS): string {
  const m = toLocal(at, offsetMs);
  const y = m.getUTCFullYear();
  const mo = String(m.getUTCMonth() + 1).padStart(2, "0");
  const da = String(m.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** First & last localDate (inclusive) of the local month containing `at`. */
export function monthRange(
  at: Date = new Date(),
  offsetMs: number = DEFAULT_OFFSET_MS,
): { start: string; end: string } {
  const m = toLocal(at, offsetMs);
  const y = m.getUTCFullYear();
  const mo = m.getUTCMonth();
  const first = new Date(Date.UTC(y, mo, 1));
  const last = new Date(Date.UTC(y, mo + 1, 0));
  return { start: fmt(first), end: fmt(last) };
}

/** Monday-of-week localDate — the summary_runs primary key. */
export function currentWeekStart(
  at: Date = new Date(),
  offsetMs: number = DEFAULT_OFFSET_MS,
): string {
  const m = toLocal(at, offsetMs);
  const dow = m.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const monday = new Date(
    Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() - daysSinceMonday),
  );
  return fmt(monday);
}

/** Local hour (0-23) for an instant — used to assert cron mapping. */
export function localHour(at: Date, offsetMs: number = DEFAULT_OFFSET_MS): number {
  return toLocal(at, offsetMs).getUTCHours();
}

/** Day-of-month (1-31) in local time for an instant. */
export function localDayOfMonth(
  at: Date = new Date(),
  offsetMs: number = DEFAULT_OFFSET_MS,
): number {
  return toLocal(at, offsetMs).getUTCDate();
}

/** Day-of-week (0=Sun..6=Sat) in local time for an instant. */
export function localDayOfWeek(
  at: Date = new Date(),
  offsetMs: number = DEFAULT_OFFSET_MS,
): number {
  return toLocal(at, offsetMs).getUTCDay();
}

/** Number of days in the local month containing `at` (e.g. 28/29 for Feb, 30, 31). */
export function daysInLocalMonth(
  at: Date = new Date(),
  offsetMs: number = DEFAULT_OFFSET_MS,
): number {
  const m = toLocal(at, offsetMs);
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

export type DateResult = { ok: true; date: string } | { ok: false; reason: string };

/**
 * Validate a YYYY-MM-DD as a real, past-or-today Manila calendar date — for backdated logging
 * ("I spent 500 on groceries yesterday"). The LLM resolves the natural-language date against the
 * <today> block it's given; this hardens the structured result the same way parseAmount hardens
 * amounts: reject malformed input, non-calendar dates (e.g. 2026-02-30), the future, and absurd
 * typos far in the past.
 */
export function validateLogDate(input: string, now: Date = new Date()): DateResult {
  const s = input.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false, reason: "date must be YYYY-MM-DD" };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  // Round-trip through Date.UTC: a non-calendar date like 2026-02-30 rolls over to Mar 2, so the
  // reconstructed components won't match the input.
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
    return { ok: false, reason: "not a real date" };
  }
  const today = localDate(now);
  if (s > today) return { ok: false, reason: "can't log a future date" };
  // 5 years of backdating is plenty for this app; beyond that it's almost certainly a typo'd year.
  if (y < Number(today.slice(0, 4)) - 5) return { ok: false, reason: "that's too far back" };
  return { ok: true, date: s };
}

/**
 * Validate a YYYY-MM-DD as a real calendar date in EITHER direction (unlike validateLogDate, a goal
 * deadline can be in the future). Used by createGoal/editGoal so a raw natural-language date can
 * never reach the DB and later render as "Invalid Date"/NaN pace in goalProgressMessage.
 */
export function validateCalendarDate(input: string): DateResult {
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
  return { ok: true, date: s };
}

/**
 * An instant safely inside the Manila month named by `yyyymm` (YYYY-MM), for passing as the `at`
 * argument to month-scoped queries (monthRange / getMonthOverview / getSpendingByCategory /
 * getInsights). Returns null on malformed input. Noon Manila on the 15th is comfortably mid-month
 * regardless of offset handling, so monthRange resolves to exactly this calendar month.
 */
export function monthAnchor(yyyymm: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyymm.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  if (y < 2000 || y > 2100) return null;
  // 15th 12:00 Manila = 15th 04:00 UTC; toManila() reads it back as the 15th in-month.
  return new Date(Date.UTC(y, mo - 1, 15, 4, 0, 0));
}

/**
 * An anchor instant mid-month in the local month BEFORE the one containing `at`. Used to default
 * "compare to last month". Built from the local year/month so it's correct across the
 * January→December year boundary.
 */
export function prevMonthAnchor(at: Date = new Date(), offsetMs: number = DEFAULT_OFFSET_MS): Date {
  const m = toLocal(at, offsetMs);
  // Day 15 of (thisMonth - 1); Date.UTC normalizes month -1 into the prior year when needed.
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 15, 4, 0, 0));
}
