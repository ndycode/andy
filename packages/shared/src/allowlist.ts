/**
 * Single-user allowlist — the v1 security boundary. Normalize both sides to E.164
 * digits and compare in the same form (constant-time). Never store reversible PII crypto.
 */

/** Normalize a phone string to "+<digits>" E.164-ish form. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits ? `+${digits}` : "";
}

/** Constant-time string compare to avoid timing leaks on the boundary check. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** True iff `inbound` matches the single allowed number after normalization. */
export function isAllowed(inbound: string, allowed: string): boolean {
  const a = normalizePhone(inbound);
  const b = normalizePhone(allowed);
  if (a === "" || b === "") return false;
  return constantTimeEqual(a, b);
}
