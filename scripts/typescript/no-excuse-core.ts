import { addCatchViolations } from "./no-excuse-catches";
import { maskComments, maskLiterals } from "./no-excuse-literals";
import { addNonNullAssertionViolations } from "./no-excuse-non-null";
import { addDirectiveRuleViolations, addSimpleRuleViolations } from "./no-excuse-rule-metadata";
import { publicViolations } from "./no-excuse-scan-context";
import type { LocatedViolation, Violation } from "./no-excuse-types";

export type { RuleId, Violation } from "./no-excuse-types";

export function checkSource(filePath: string, source: string): readonly Violation[] {
  const violations: LocatedViolation[] = [];
  const sourceWithoutLiterals = maskLiterals(source);
  const sourceForRules = maskComments(sourceWithoutLiterals);
  const context = { filePath, source, sourceForRules, violations };

  addDirectiveRuleViolations(context, sourceWithoutLiterals);
  addSimpleRuleViolations(context);
  addNonNullAssertionViolations(context);
  addCatchViolations(context);

  return publicViolations(violations);
}
