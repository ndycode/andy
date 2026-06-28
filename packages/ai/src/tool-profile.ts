export type ToolProfile =
  | "chat"
  | "log"
  | "readBasic"
  | "readSearch"
  | "readPace"
  | "readInsight"
  | "readCompare"
  | "read"
  | "memoryRead"
  | "memory"
  | "goalRead"
  | "goal"
  | "budgetRead"
  | "budget"
  | "recurringRead"
  | "recurring"
  | "full";

const AMOUNT_RE = /(?:₱|php\s*)?\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b/i;

export function selectToolProfile(text: string): ToolProfile {
  const t = normalize(text);
  if (!t) return "chat";

  const hasAmount = AMOUNT_RE.test(t);
  const hasQuestion = isQuestionLike(t);
  const hasInsightRead =
    /\b(insights?|patterns?|leak|leaking|weekend|weekday|where'?s my money leaking|where is my money leaking)\b/.test(
      t,
    );
  const hasCompareRead = /\b(compare|compared|versus|vs|trend|trends|spending more than)\b/.test(t);
  const hasPaceRead =
    /\b(pace|on track|will i overspend|gonna blow|blow\b.*\bbudget|project|projected)\b/.test(t);
  const hasSearchRead =
    /\b(find|search|biggest|largest|transactions?|history)\b/.test(t) ||
    /\b(anything|expenses?)\b.*\b(over|above|under|below)\b/.test(t) ||
    /\b(over|above|under|below)\s+(?:₱|php\s*)?\d/.test(t);
  const analysisProfiles = [
    hasSearchRead && "readSearch",
    hasPaceRead && "readPace",
    hasInsightRead && "readInsight",
    hasCompareRead && "readCompare",
  ].filter(Boolean) as Array<"readSearch" | "readPace" | "readInsight" | "readCompare">;
  const focusedAnalysisProfile = analysisProfiles.length === 1 ? analysisProfiles[0] : null;
  const hasAnalysisRead = analysisProfiles.length > 0;
  const hasBasicRead =
    hasQuestion ||
    /\b(recent|breakdown|overview|spent so far|spending|expenses?|net|income|where.*money)\b/.test(
      t,
    );
  const hasRead = hasBasicRead || hasAnalysisRead;
  const hasGeneralRead =
    /\b(how am i doing|am i broke|overview|spent so far|spending|expenses?|net|income|where.*money|breakdown)\b/.test(
      t,
    ) ||
    (hasQuestion && !/\b(budget|budgets|goal|fund|recurring|remind|reminder)\b/.test(t));
  const hasGoal =
    /\b(goal|fund|save|saving|saved|contribute|japan|trip|emergency|laptop)\b/.test(t) ||
    /\bput\s+.+\b(to|into|towards?)\b/.test(t);
  const hasGoalManagement = /\b(delete|remove|cancel|rename|make|move|change|edit|update)\b/.test(
    t,
  );
  const hasGoalRead =
    hasGoal &&
    !hasAmount &&
    !hasGoalManagement &&
    /\b(how'?s|how is|what'?s|status|progress|on track|pace|doing)\b/.test(t);
  const hasBudget = /\b(budget|budgets|cap|limit|within budget|overspend)\b/.test(t);
  const hasBudgetManagement = /\b(drop|remove|delete|stop|clear|cancel)\b/.test(t);
  const hasBudgetRead =
    hasBudget &&
    !hasAmount &&
    !hasBudgetManagement &&
    (hasQuestion || /\b(check|status|within|show|list|view|see)\b/.test(t));
  const hasRecurring =
    /\b(recurring|remind|reminder|every\s+\d+(?:st|nd|rd|th)?|every\s+\w+day|weekly|monthly)\b/.test(
      t,
    );
  const hasRecurringManagement =
    /\b(delete|remove|cancel|stop|pause|rename|make|move|change|edit|update)\b/.test(t);
  const hasRecurringRead =
    hasRecurring &&
    !hasAmount &&
    !hasRecurringManagement &&
    (hasQuestion || /\b(list|show|view|see|which)\b/.test(t));
  const hasMemory =
    /\b(remember|forget|memory|memories|what do you know|dont remember|don't remember)\b/.test(t);
  const hasMemoryManagement = /\b(forget|dont remember|don't remember|delete|remove)\b/.test(t);
  const hasMemoryRead =
    hasMemory &&
    !hasMemoryManagement &&
    /\b(what do you know|what do you remember|what have you remembered|list|show|view|see|memory|memories)\b/.test(
      t,
    );
  const hasCorrection =
    /\b(delete that|scratch that|undo|make that|change it|actually|no,?|no wait)\b/.test(t);
  const hasLogHint =
    hasAmount &&
    /\b(spent|paid|bought|got|grab|taxi|fare|gas|fuel|parking|toll|lunch|dinner|breakfast|coffee|snack|groceries|grocery|load|rent|netflix|subscription|salary|sweldo|income)\b/.test(
      t,
    );

  if (hasMemory && !/\b(recurring|remind|reminder)\b/.test(t)) {
    return hasMemoryRead ? "memoryRead" : "memory";
  }
  if (hasRecurring && !hasMemory && !hasBudget && !hasGoal) {
    return hasRecurringRead ? "recurringRead" : "recurring";
  }
  if (hasLogHint && hasRead) return "full";
  if (focusedAnalysisProfile && !hasGoal && !hasRecurring && !hasMemory) {
    return focusedAnalysisProfile;
  }

  const readNeedsSeparateProfile =
    hasRead &&
    !hasLogHint &&
    !(hasQuestion && (hasBudget || hasGoal || hasRecurring) && !hasGeneralRead);
  const specificCount = [
    hasMemory,
    hasBudget,
    hasRecurring,
    hasGoal,
    readNeedsSeparateProfile,
    hasLogHint || hasCorrection,
  ].filter(Boolean).length;

  // Mixed turns need the whole tool surface, e.g. "grab 180 and how am i doing" or
  // "set food budget 5k and how are my budgets".
  if (specificCount > 1) return "full";

  if (hasMemory) return hasMemoryRead ? "memoryRead" : "memory";
  if (hasBudget) return hasBudgetRead ? "budgetRead" : "budget";
  if (hasRecurring) return "recurring";
  if (hasGoal) return hasGoalRead ? "goalRead" : "goal";
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
