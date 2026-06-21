import { addViolation, type ScanContext } from "./no-excuse-scan-context";

export function addNonNullAssertionViolations(context: ScanContext): void {
  for (let index = 0; index < context.sourceForRules.length; index++) {
    if (context.sourceForRules[index] !== "!") continue;
    if (context.sourceForRules[index + 1] === "=") continue;
    const previous = context.sourceForRules[index - 1];
    if (!isNonNullAssertionTarget(previous)) continue;
    addViolation(
      context,
      index,
      "no-non-null-assertion",
      "Do not use non-null assertions; narrow the value instead.",
    );
  }
}

function isNonNullAssertionTarget(previous: string | undefined): boolean {
  if (!previous || /\s/.test(previous) || previous === "=" || previous === "!") return false;
  return /[A-Za-z0-9_$)\]]/.test(previous);
}
