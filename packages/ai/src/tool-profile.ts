export type ToolProfile =
  | "chat"
  | "log"
  | "readBasic"
  | "read"
  | "memory"
  | "goal"
  | "budget"
  | "recurring"
  | "full";

const AMOUNT_RE = /(?:₱|php\s*)?\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b/i;

export function selectToolProfile(text: string): ToolProfile {
  const t = normalize(text);
  if (!t) return "chat";

  const hasAmount = AMOUNT_RE.test(t);
  const hasQuestion = isQuestionLike(t);
  const hasAnalysisRead =
    /\b(insights?|compare|compared|versus|vs|pace|on track|trend|trends|find|search|biggest|largest|over|above|under|below|anything|transactions?|history|leak|weekend|weekday)\b/.test(
      t,
    );
  const hasBasicRead =
    hasQuestion ||
    /\b(recent|breakdown|overview|spent so far|spending|expenses?|net|income|where.*money)\b/.test(
      t,
    );
  const hasRead = hasBasicRead || hasAnalysisRead;
  const hasGoal =
    /\b(goal|fund|save|saving|saved|contribute|japan|trip|emergency|laptop)\b/.test(t) ||
    /\bput\s+.+\b(to|into|towards?)\b/.test(t);
  const hasBudget = /\b(budget|budgets|cap|limit|within budget|overspend)\b/.test(t);
  const hasRecurring =
    /\b(recurring|remind|reminder|every\s+\d+(?:st|nd|rd|th)?|every\s+\w+day|weekly|monthly)\b/.test(
      t,
    );
  const hasMemory = /\b(remember|forget|what do you know|dont remember|don't remember)\b/.test(t);
  const hasCorrection =
    /\b(delete that|scratch that|undo|make that|change it|actually|no,?|no wait)\b/.test(t);
  const hasLogHint =
    hasAmount &&
    /\b(spent|paid|bought|got|grab|taxi|fare|gas|fuel|parking|toll|lunch|dinner|breakfast|coffee|snack|groceries|grocery|load|rent|netflix|subscription|salary|sweldo|income)\b/.test(
      t,
    );

  if (hasMemory && !/\b(recurring|remind|reminder)\b/.test(t)) return "memory";
  if (hasRecurring && !hasMemory && !hasBudget && !hasGoal) return "recurring";
  if (hasLogHint && hasRead) return "full";

  const specificCount = [
    hasMemory,
    hasBudget,
    hasRecurring,
    hasGoal,
    hasRead && !hasLogHint,
    hasLogHint || hasCorrection,
  ].filter(Boolean).length;

  // Mixed turns need the whole tool surface, e.g. "grab 180 and how am i doing" or
  // "set food budget 5k and how are my budgets".
  if (specificCount > 1) return "full";

  if (hasMemory) return "memory";
  if (hasBudget) return "budget";
  if (hasRecurring) return "recurring";
  if (hasGoal) return "goal";
  if (hasRead && !hasLogHint) return hasAnalysisRead ? "read" : "readBasic";
  if (hasLogHint || hasCorrection || hasAmount) return "log";
  return "chat";
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function isQuestionLike(text: string): boolean {
  return (
    text.includes("?") ||
    /\b(how|what|when|where|why)\b/.test(text) ||
    /\b(am|are|can|should|could|did|do)\s+i\b/.test(text) ||
    /\bhow much\b/.test(text)
  );
}
