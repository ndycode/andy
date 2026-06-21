export type RuleId =
  | "no-any-assertion"
  | "no-unknown-assertion"
  | "no-ts-ignore"
  | "no-ts-expect-error"
  | "no-enum"
  | "no-non-null-assertion"
  | "no-throw-literal"
  | "no-mutable-export"
  | "no-any-annotation"
  | "no-explicit-any-return"
  | "empty-catch"
  | "catch-without-narrowing";

export interface Violation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly ruleId: RuleId;
  readonly message: string;
}

export interface LocatedViolation extends Violation {
  readonly index: number;
}
