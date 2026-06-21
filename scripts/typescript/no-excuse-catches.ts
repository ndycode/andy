import {
  addViolation,
  hasOptOut,
  matchingBraceIndex,
  type ScanContext,
} from "./no-excuse-scan-context";

export function addCatchViolations(context: ScanContext): void {
  addSynchronousCatchViolations(context);
  addEmptyPromiseCatchViolations(context);
}

function addSynchronousCatchViolations(context: ScanContext): void {
  for (const match of context.sourceForRules.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*{/g)) {
    if (match.index === undefined) continue;
    if (hasOptOut(context.source, match.index, "catch")) continue;

    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchingBraceIndex(context.sourceForRules, openIndex);
    if (closeIndex === null) continue;

    const body = context.sourceForRules.slice(openIndex + 1, closeIndex);
    if (body.trim().length === 0) {
      addViolation(context, match.index, "empty-catch", "Do not leave catch blocks empty.");
    } else if (!/\binstanceof\b|\bthrow\b/.test(body)) {
      addViolation(
        context,
        match.index,
        "catch-without-narrowing",
        "Catch blocks must narrow with instanceof or rethrow.",
      );
    }
  }
}

function addEmptyPromiseCatchViolations(context: ScanContext): void {
  for (const match of context.sourceForRules.matchAll(
    /\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*{\s*}\s*\)/g,
  )) {
    if (match.index === undefined) continue;
    if (hasOptOut(context.source, match.index, "catch")) continue;
    addViolation(context, match.index, "empty-catch", "Do not leave promise catch handlers empty.");
  }
}
