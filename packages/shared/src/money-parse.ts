import { MAX_ENTRY_CENTAVOS } from "./money-limits";

export type ParseResult = { ok: true; centavos: number } | { ok: false; reason: string };

/**
 * Convert a clean decimal string times a 10^k multiplier into integer centavos without a float
 * intermediate. This preserves half-up rounding for sub-centavo precision.
 */
function decimalToCentavos(s: string, multiplier: number): number {
  const [intRaw, fracRaw = ""] = s.split(".");
  const k = multiplier === 1_000_000 ? 6 : multiplier === 1_000 ? 3 : 0;
  // Do not strip leading zeros: digits is sliced positionally against fracRaw.length below.
  const digits = `${intRaw}${fracRaw}` || "0";
  const exp = 2 + k - fracRaw.length;
  if (exp >= 0) return Number(digits) * 10 ** exp;

  const cut = -exp;
  const keep = digits.slice(0, digits.length - cut) || "0";
  const dropped = digits.slice(digits.length - cut);
  let c = Number(keep);
  if (dropped.charCodeAt(0) - 48 >= 5) c += 1;
  return c;
}

/**
 * Parse a human amount token into integer centavos.
 * Accepts: "180", "180.50", "25k", "1.5k", "25K", "₱180", "1,250.75".
 */
export function parseAmount(raw: string): ParseResult {
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  let s = raw.trim().toLowerCase();
  if (s === "") return { ok: false, reason: "empty" };

  if (/\d\s*(?:-|to|–|—)\s*\d/.test(s)) {
    return { ok: false, reason: "looks like a range — send one amount" };
  }

  s = s
    .replace(/₱|php|pesos?/g, "")
    .replace(/\s/g, "")
    .trim();

  let multiplier = 1;
  const suffix = s.at(-1);
  if (suffix === "k") {
    multiplier = 1_000;
    s = s.slice(0, -1);
  } else if (suffix === "m") {
    multiplier = 1_000_000;
    s = s.slice(0, -1);
  }

  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s.startsWith(".")) s = `0${s}`;

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
