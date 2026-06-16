/**
 * PHP money as integer centavos. No floats in any money math.
 * The LLM never computes centavos — it extracts a raw token, parseAmount converts.
 */

/** App-level caps, both far below Number.MAX_SAFE_INTEGER (~9.007e15) so sums stay exact. */
export const MAX_ENTRY_CENTAVOS = 100_000_000_000; // ₱1,000,000,000 per single entry
export const MAX_AGGREGATE_CENTAVOS = 10_000_000_000_000; // ₱100,000,000,000 aggregate headroom

export type ParseResult = { ok: true; centavos: number } | { ok: false; reason: string };

/**
 * Convert a clean decimal string (digits with at most one '.') times a 10^k multiplier into
 * integer centavos with NO float intermediate. value = digits / 10^fracLen; centavos = value * 100 *
 * multiplier = digits * 10^(2 + k - fracLen). When that exponent is non-negative the result is an
 * exact integer; when negative (more fractional precision than a centavo can hold, e.g. "1.005") we
 * round half-up on the dropped tail. This avoids the float-multiply drift the old `Math.round(pesos *
 * 100)` had (1.005 * 100 = 100.49999… → 100 instead of 101).
 */
function decimalToCentavos(s: string, multiplier: number): number {
  const [intRaw, fracRaw = ""] = s.split(".");
  const k = multiplier === 1_000_000 ? 6 : multiplier === 1_000 ? 3 : 0;
  // Do NOT strip leading zeros here: `digits` is sliced by position against `fracRaw.length` in the
  // negative-exp branch below, so dropping characters off the front misaligns the keep/dropped split
  // (it made "0.0005" round to 1 centavo instead of 0). Number() handles any leading zeros fine.
  const digits = `${intRaw}${fracRaw}` || "0";
  const exp = 2 + k - fracRaw.length;
  if (exp >= 0) return Number(digits) * 10 ** exp;
  // Fewer centavo slots than fractional digits: drop the tail, rounding half-up on the first dropped.
  const cut = -exp;
  const keep = digits.slice(0, digits.length - cut) || "0";
  const dropped = digits.slice(digits.length - cut);
  let c = Number(keep);
  if (dropped.charCodeAt(0) - 48 >= 5) c += 1; // half-up
  return c;
}

/**
 * Parse a human amount token into integer centavos.
 * Accepts: "180", "180.50", "25k", "1.5k", "25K", "₱180", "1,250.75".
 * Rejects: empty, non-numeric, negative, zero, NaN, over-cap, malformed digit grouping ("1,00,000").
 */
export function parseAmount(raw: string): ParseResult {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  let s = raw.trim().toLowerCase();
  if (s === "") return { ok: false, reason: "empty" };

  // A range ("100-200", "100 to 200") is ambiguous — surface a clear ask instead of silently
  // mangling it (the old path stripped the dash and produced a wrong number or a vague reject).
  if (/\d\s*(?:-|to|–|—)\s*\d/.test(s)) {
    return { ok: false, reason: "looks like a range — send one amount" };
  }

  // strip peso sign, currency code, spaces — but KEEP commas so we can validate the grouping below.
  s = s
    .replace(/₱|php|pesos?/g, "")
    .replace(/\s/g, "")
    .trim();

  // optional k/m suffix multiplier
  let multiplier = 1;
  const suffix = s.at(-1);
  if (suffix === "k") {
    multiplier = 1_000;
    s = s.slice(0, -1);
  } else if (suffix === "m") {
    multiplier = 1_000_000;
    s = s.slice(0, -1);
  }

  // Normalize a trailing dot ("150." from a sentence) and a bare leading dot (".50" → "0.50").
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.startsWith(".")) s = `0${s}`;

  // If commas are present they MUST be valid thousands separators. The old code stripped all commas
  // unconditionally, so "1,00,000" (foreign grouping) or a typo'd "1,2,3" was silently read as a
  // different number — a silent-wrong-money path, the one class this app most wants to avoid.
  if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
      return { ok: false, reason: "that grouping looks off — send the plain number" };
    }
    s = s.replace(/,/g, "");
  }

  if (s === "" || !/^\d*\.?\d+$/.test(s)) {
    return { ok: false, reason: `unparseable amount: "${raw}"` };
  }

  const centavos = decimalToCentavos(s, multiplier);
  if (!Number.isFinite(centavos)) return { ok: false, reason: "not finite" };
  if (centavos <= 0) return { ok: false, reason: "must be positive" };
  if (centavos > MAX_ENTRY_CENTAVOS) return { ok: false, reason: "exceeds per-entry cap" };

  return { ok: true, centavos };
}

const PHP = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format integer centavos as "₱25,000.00". Division happens only here, at display. */
export function formatPHP(centavos: number): string {
  if (!Number.isInteger(centavos)) {
    throw new Error(`formatPHP expects integer centavos, got ${centavos}`);
  }
  const sign = centavos < 0 ? "-" : "";
  return `${sign}₱${PHP.format(Math.abs(centavos) / 100)}`;
}

/** Exact integer sum of centavos with cap guard. */
export function sumCentavos(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error(`non-integer centavos: ${v}`);
    total += v;
  }
  if (Math.abs(total) > MAX_AGGREGATE_CENTAVOS) {
    throw new Error("aggregate exceeds safe cap");
  }
  return total;
}

/**
 * Validate-and-coerce a centavo total read back from SQL (a `::bigint` aggregate arrives as a string
 * or number) into a safe JS integer. Enforces the SAME aggregate invariant `sumCentavos` documents,
 * but on the path that actually computes sums — a Postgres `SUM()` can reach ~9.2e18, and `Number()`
 * of anything above 2^53 silently loses integer precision. Throws above MAX_AGGREGATE_CENTAVOS rather
 * than returning a quietly-wrong total. Use everywhere a money aggregate crosses the DB→JS boundary.
 */
export function toSafeCentavos(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) throw new Error(`non-finite centavos: ${value}`);
  if (!Number.isInteger(n)) throw new Error(`non-integer centavos: ${value}`);
  if (Math.abs(n) > MAX_AGGREGATE_CENTAVOS) {
    throw new Error(`centavo aggregate exceeds safe cap: ${value}`);
  }
  return n;
}
