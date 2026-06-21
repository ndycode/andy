import { addViolation, hasOptOut, type ScanContext } from "./no-excuse-scan-context";
import type { RuleId } from "./no-excuse-types";

interface SimpleRule {
  readonly ruleId: RuleId;
  readonly pattern: RegExp;
  readonly message: string;
  readonly optOut?: string;
}

const SIMPLE_RULES: readonly SimpleRule[] = [
  {
    ruleId: "no-any-assertion",
    pattern: /\bas\s+any\b/g,
    message: "Do not use 'as any'; narrow or model the type instead.",
  },
  {
    ruleId: "no-unknown-assertion",
    pattern: /\bas\s+unknown\b/g,
    message: "Do not use 'as unknown'; fix the type boundary instead.",
  },
  {
    ruleId: "no-enum",
    pattern: /\benum\s+[A-Za-z_$][\w$]*/g,
    message: "Use an 'as const' object plus a literal union instead of enum.",
  },
  {
    ruleId: "no-throw-literal",
    pattern: /\bthrow\s+(?:["'`]|[0-9])/g,
    message: "Throw an Error subclass instead of a literal value.",
  },
  {
    ruleId: "no-mutable-export",
    pattern: /\bexport\s+(?:let|var)\s+/g,
    message: "Export immutable bindings only; use export const.",
  },
  {
    ruleId: "no-any-annotation",
    pattern: /:\s*any\b/g,
    message: "Do not annotate values as any; use unknown and narrow.",
    optOut: "any",
  },
  {
    ruleId: "no-explicit-any-return",
    pattern: /\)\s*:\s*(?:Promise\s*<\s*)?any\b/g,
    message: "Do not return any; model the return type.",
    optOut: "any",
  },
];

const DIRECTIVE_RULES: readonly SimpleRule[] = [
  {
    ruleId: "no-ts-ignore",
    pattern: /@ts-ignore/g,
    message: "Do not suppress TypeScript diagnostics with @ts-ignore.",
  },
  {
    ruleId: "no-ts-expect-error",
    pattern: /@ts-expect-error/g,
    message: "Do not suppress TypeScript diagnostics with @ts-expect-error.",
  },
];

export function addDirectiveRuleViolations(
  context: ScanContext,
  sourceWithoutLiterals: string,
): void {
  for (const rule of DIRECTIVE_RULES) {
    for (const match of sourceWithoutLiterals.matchAll(rule.pattern)) {
      if (match.index === undefined) continue;
      addViolation(context, match.index, rule.ruleId, rule.message);
    }
  }
}

export function addSimpleRuleViolations(context: ScanContext): void {
  for (const rule of SIMPLE_RULES) {
    for (const match of context.sourceForRules.matchAll(rule.pattern)) {
      if (match.index === undefined) continue;
      if (rule.optOut && hasOptOut(context.source, match.index, rule.optOut)) continue;
      addViolation(context, match.index, rule.ruleId, rule.message);
    }
  }
}
