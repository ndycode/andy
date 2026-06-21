import { constantTimeEqual } from "@repo/shared/security";

export function hasValidBearerToken(
  header: string | null | undefined,
  expectedSecret: string,
): boolean {
  if (!header || !expectedSecret) return false;
  return constantTimeEqual(header, `Bearer ${expectedSecret}`);
}
