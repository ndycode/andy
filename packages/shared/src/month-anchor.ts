import { DEFAULT_OFFSET_MS, localDate } from "./local-time";

/**
 * An instant safely inside the Manila month named by `yyyymm` (YYYY-MM), for passing as the `at`
 * argument to month-scoped queries. Returns null on malformed input. Noon Manila on the 15th is
 * comfortably mid-month regardless of offset handling, so monthRange resolves to exactly this month.
 */
export function monthAnchor(yyyymm: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyymm.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  if (y < 2000 || y > 2100) return null;
  // 15th 12:00 Manila = 15th 04:00 UTC; localDate/monthRange read it back as in-month.
  return new Date(Date.UTC(y, mo - 1, 15, 4, 0, 0));
}

/**
 * An anchor instant mid-month in the local month before the one containing `at`. Used to default
 * "compare to last month". Built from the local year/month so it is correct across year boundaries.
 */
export function prevMonthAnchor(at: Date = new Date(), offsetMs: number = DEFAULT_OFFSET_MS): Date {
  const local = localDate(at, offsetMs);
  const year = Number(local.slice(0, 4));
  const month = Number(local.slice(5, 7));
  return new Date(Date.UTC(year, month - 2, 15, 4, 0, 0));
}
