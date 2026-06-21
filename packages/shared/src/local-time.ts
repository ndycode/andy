/**
 * Fixed-offset local-time helpers. The app's single user lives in Asia/Manila (UTC+8, no DST), so
 * we shift by a deterministic offset rather than depending on host TZ database data. The offset is
 * still a parameter so other fixed-offset zones work without code changes.
 *
 * Scope note: this models fixed-offset zones only. Zones with DST would need a real tz library;
 * that's intentionally out of scope until a non-fixed-offset user exists.
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
