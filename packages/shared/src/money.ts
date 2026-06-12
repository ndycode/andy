/**
 * PHP money as integer centavos. No floats in any money math.
 * The LLM never computes centavos — it extracts a raw token, parseAmount converts.
 */

/** App-level caps, both far below Number.MAX_SAFE_INTEGER (~9.007e15) so sums stay exact. */
export const MAX_ENTRY_CENTAVOS = 100_000_000_000; // ₱1,000,000,000 per single entry
export const MAX_AGGREGATE_CENTAVOS = 10_000_000_000_000; // ₱100,000,000,000 aggregate headroom

export type ParseResult = { ok: true; centavos: number } | { ok: false; reason: string };

/**
 * Parse a human amount token into integer centavos.
 * Accepts: "180", "180.50", "25k", "1.5k", "25K", "₱180", "1,250.75".
 * Rejects: empty, non-numeric, negative, zero, NaN, over-cap.
 */
export function parseAmount(raw: string): ParseResult {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  let s = raw.trim().toLowerCase();
  if (s === "") return { ok: false, reason: "empty" };

  // strip peso sign, currency code, spaces, thousands separators
  s = s.replace(/₱|php/g, "").replace(/,/g, "").replace(/\s/g, "").trim();

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

  if (s === "" || !/^\d*\.?\d+$/.test(s)) {
    return { ok: false, reason: `unparseable amount: "${raw}"` };
  }

  const pesos = Number(s) * multiplier;
  if (!Number.isFinite(pesos)) return { ok: false, reason: "not finite" };
  if (pesos <= 0) return { ok: false, reason: "must be positive" };

  // round to centavos via integer math to avoid float drift (e.g. 180.50 -> 18050)
  const centavos = Math.round(pesos * 100);
  if (centavos <= 0) return { ok: false, reason: "rounds to zero" };
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
