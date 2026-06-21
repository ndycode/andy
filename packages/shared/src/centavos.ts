import { MAX_AGGREGATE_CENTAVOS } from "./money-limits";

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

/** Validate and coerce a centavo total read back from SQL into a safe JS integer. */
export function toSafeCentavos(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) throw new Error(`non-finite centavos: ${value}`);
  if (!Number.isInteger(n)) throw new Error(`non-integer centavos: ${value}`);
  if (Math.abs(n) > MAX_AGGREGATE_CENTAVOS) {
    throw new Error(`centavo aggregate exceeds safe cap: ${value}`);
  }
  return n;
}
