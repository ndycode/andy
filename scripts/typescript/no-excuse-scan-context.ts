import type { LocatedViolation, RuleId, Violation } from "./no-excuse-types";

export interface ScanContext {
  readonly filePath: string;
  readonly source: string;
  readonly sourceForRules: string;
  readonly violations: LocatedViolation[];
}

export function addViolation(
  context: ScanContext,
  index: number,
  ruleId: RuleId,
  message: string,
): void {
  context.violations.push(
    toLocatedViolation(context.filePath, context.source, index, ruleId, message),
  );
}

export function publicViolations(violations: readonly LocatedViolation[]): readonly Violation[] {
  return [...violations].sort(bySourceIndex).map(toPublicViolation);
}

export function hasOptOut(source: string, index: number, token: string): boolean {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const previousLineStart = source.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
  return source.slice(previousLineStart, index).includes(`no-excuse-ok: ${token}`);
}

export function matchingBraceIndex(source: string, openIndex: number): number | null {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return null;
}

function toLocatedViolation(
  filePath: string,
  source: string,
  index: number,
  ruleId: RuleId,
  message: string,
): LocatedViolation {
  const { line, column } = lineColumn(source, index);
  return { filePath, line, column, ruleId, message, index };
}

function lineColumn(
  source: string,
  index: number,
): { readonly line: number; readonly column: number } {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    if (source.charCodeAt(cursor) === 10) {
      line++;
      lineStart = cursor + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

function bySourceIndex(left: LocatedViolation, right: LocatedViolation): number {
  return left.index - right.index;
}

function toPublicViolation(violation: LocatedViolation): Violation {
  return {
    filePath: violation.filePath,
    line: violation.line,
    column: violation.column,
    ruleId: violation.ruleId,
    message: violation.message,
  };
}
