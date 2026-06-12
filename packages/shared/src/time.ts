/**
 * Asia/Manila time helpers. Manila is UTC+8 year-round (no DST), so we offset
 * deterministically rather than depending on host TZ data.
 */
export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** A Date shifted into Manila wall-clock, read via getUTC* accessors. */
function toManila(d: Date): Date {
  return new Date(d.getTime() + MANILA_OFFSET_MS);
}

/** "YYYY-MM-DD" for the given instant in Manila local time. */
export function localDate(at: Date = new Date()): string {
  const m = toManila(at);
  const y = m.getUTCFullYear();
  const mo = String(m.getUTCMonth() + 1).padStart(2, "0");
  const da = String(m.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** First & last localDate (inclusive) of the Manila month containing `at`. */
export function monthRange(at: Date = new Date()): { start: string; end: string } {
  const m = toManila(at);
  const y = m.getUTCFullYear();
  const mo = m.getUTCMonth();
  const first = new Date(Date.UTC(y, mo, 1));
  const last = new Date(Date.UTC(y, mo + 1, 0));
  return { start: fmt(first), end: fmt(last) };
}

/** Monday-of-week localDate in Manila — the summary_runs primary key. */
export function currentWeekStart(at: Date = new Date()): string {
  const m = toManila(at);
  const dow = m.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const monday = new Date(
    Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate() - daysSinceMonday),
  );
  return fmt(monday);
}

/** Manila local hour (0-23) for an instant — used to assert cron mapping. */
export function manilaHour(at: Date): number {
  return toManila(at).getUTCHours();
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}
