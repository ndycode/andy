export type ToolProfile =
  | "chat"
  | "logWrite"
  | "logEdit"
  | "log"
  | "readBasic"
  | "readSearch"
  | "readPace"
  | "readInsight"
  | "readCompare"
  | "read"
  | "memoryRead"
  | "memoryRemember"
  | "memoryForget"
  | "memory"
  | "goalRead"
  | "goalCreate"
  | "goalContribute"
  | "goalManage"
  | "goal"
  | "budgetRead"
  | "budgetSet"
  | "budgetRemove"
  | "budget"
  | "recurringRead"
  | "recurringAdd"
  | "recurringEdit"
  | "recurringRemove"
  | "recurring"
  | "full";

const AMOUNT_RE = /(?:₱|php\s*)?\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b/i;
const AMOUNT_GLOBAL_RE = /(?:₱|php\s*)?\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b/gi;
const CORRECTION_RE =
  /\b(delete that|scratch that|undo|no wait|make that|make it|change it|actually|no,?)\b/i;
const CORRECTION_GLOBAL_RE =
  /\b(delete that|scratch that|undo|no wait|make that|make it|change it|actually|no,?)\b/gi;
const PAYDAY_MEMORY_RE =
  /\b(?:i\s+(?:get\s+paid|am\s+paid)|my\s+(?:payday|salary|sweldo|paycheck)|payday|salary|sweldo)\b.*\b(?:every|on|is|are|comes?|lands?|\d{1,2}(?:st|nd|rd|th)?)\b/;
const PREFERENCE_MEMORY_RE =
  /\b(?:i\s+(?:like|love|prefer|usually|(?:always|often)\s+(?:get|order|drink|eat|buy|use|pay\s+with))|i\s+(?:do\s+not\s+like|don't\s+like|hate\s+(?!this\b|that\b|it\b|you\b|them\b))|my\s+(?:favou?rite|usual|default|go-?to)|[\w'-]+(?:\s+[\w'-]+){0,4}\s+is\s+my\s+(?:favou?rite|usual|default|go-?to))\b/;
const PREFERENCE_MEMORY_READ_RE =
  /\b(?:do|did)\s+i\s+(?:like|love|prefer|usually|(?:always|often)\s+(?:get|order|drink|eat|buy|use|pay\s+with)|hate)\b|\bwhat(?:'s| is)\s+my\s+(?:favou?rite|usual|default|go-?to)\b|\bis\s+[\w'-]+(?:\s+[\w'-]+){0,4}\s+my\s+(?:favou?rite|usual|default|go-?to)\b/;
const PROFILE_MEMORY_RE =
  /\b(?:my\s+(?:name|nickname|office|home|address|city|location)\s+is|call\s+me|i\s+live\s+in|i\s+work\s+(?:in|at)|my\s+work\s+is)\b/;
const PROFILE_MEMORY_READ_RE =
  /\b(?:what'?s|what is)\s+my\s+(?:name|nickname|address|city|location)\b|\bwhere\s+do\s+i\s+(?:live|work)\b|\bwhere(?:'s| is| was)\s+my\s+(?:home|office|address|city|location|work)\b/;
const BASIC_READ_STATEMENT_RE =
  /\b(recent|breakdown|overview|spent so far|spending|expenses?|net|income|where.*money)\b/;
const BASIC_READ_QUESTION_RE =
  /\b(how much|how am i doing|am i broke|am i ok|am i okay|afford|spent|spend|spending|expenses?|net|income|cash|money|breakdown|overview|recent|left|payday|sweldo|salary)\b/;
const DOMAIN_READ_RE = /\b(budget|budgets|goal|fund|recurring|remind|reminder)\b/;

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
    BASIC_READ_STATEMENT_RE.test(t) || (hasQuestion && BASIC_READ_QUESTION_RE.test(t));
  const hasRead = hasBasicRead || hasAnalysisRead;
  const hasGeneralRead =
    /\b(how am i doing|am i broke|overview|spent so far|spending|expenses?|net|income|where.*money|breakdown)\b/.test(
      t,
    ) ||
    (hasQuestion && BASIC_READ_QUESTION_RE.test(t) && !DOMAIN_READ_RE.test(t));
  const hasGoal =
    /\b(goal|fund|save|saving|saved|contribute|japan|trip|emergency|laptop)\b/.test(t) ||
    /\bput\s+.+\b(to|into|towards?)\b/.test(t);
  const hasGoalManagement = /\b(delete|remove|cancel|rename|make|move|change|edit|update)\b/.test(
    t,
  );
  const hasGoalContribution =
    hasAmount &&
    (/\bput\s+.+\b(to|into|towards?)\b/.test(t) ||
      /\b(contribute|add|deposit|saved)\b.+\b(to|into|towards?|for)\b/.test(t));
  const hasGoalCreate = hasGoal && hasAmount && !hasGoalContribution && !hasGoalManagement;
  const hasGoalRead =
    hasGoal &&
    !hasAmount &&
    !hasGoalManagement &&
    /\b(how'?s|how is|what'?s|status|progress|on track|pace|doing)\b/.test(t);
  const hasBudget = /\b(budget|budgets|cap|limit|within budget|overspend)\b/.test(t);
  const hasBudgetManagement = /\b(drop|remove|delete|stop|clear|cancel)\b/.test(t);
  const hasBudgetWriteAndRead =
    hasBudget &&
    hasAmount &&
    /(?:\band\b|\bthen\b|\balso\b|[,;]).*\b(how|within|check|status|budgets?)\b/.test(t);
  const hasBudgetRemoveAndRead =
    hasBudget &&
    hasBudgetManagement &&
    /(?:\band\b|\bthen\b|\balso\b|[,;]).*\b(how|within|check|status|show|list|budgets?)\b/.test(t);
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
  const hasRecurringRemove = /\b(delete|remove|cancel|stop|pause)\b/.test(t);
  const hasRecurringEdit = /\b(rename|make|move|change|edit|update)\b/.test(t);
  const hasRecurringActionAndRead =
    hasRecurring &&
    (hasAmount || hasRecurringManagement) &&
    /(?:\band\b|\bthen\b|\balso\b|[,;]).*\b(what|list|show|view|see|which|recurring|reminders?)\b/.test(
      t,
    );
  const hasRecurringRead =
    hasRecurring &&
    !hasAmount &&
    !hasRecurringManagement &&
    (hasQuestion || /\b(list|show|view|see|which)\b/.test(t));
  const hasDurableMemoryFact =
    !hasAmount &&
    !hasQuestion &&
    (PAYDAY_MEMORY_RE.test(t) || PREFERENCE_MEMORY_RE.test(t) || PROFILE_MEMORY_RE.test(t));
  const hasPreferenceMemoryRead = hasQuestion && PREFERENCE_MEMORY_READ_RE.test(t);
  const hasProfileMemoryRead = hasQuestion && PROFILE_MEMORY_READ_RE.test(t);
  const hasMemory =
    hasDurableMemoryFact ||
    hasPreferenceMemoryRead ||
    hasProfileMemoryRead ||
    /\b(remember|forget|memory|memories|what do you know|dont remember|don't remember)\b/.test(t);
  const hasMemoryManagement = /\b(forget|dont remember|don't remember|delete|remove)\b/.test(t);
  const hasMemoryRemember =
    hasDurableMemoryFact || (/\bremember\b/.test(t) && !/\bwhat do you remember\b/.test(t));
  const hasMemoryActionAndRead =
    hasMemory &&
    (hasMemoryRemember || hasMemoryManagement) &&
    /(?:\band\b|\bthen\b|\balso\b|[,;]).*\b(what do you know|what do you remember|list|show|view|see|memory|memories)\b/.test(
      t,
    );
  const hasMemoryRead =
    hasPreferenceMemoryRead ||
    hasProfileMemoryRead ||
    (hasMemory &&
      !hasMemoryManagement &&
      /\b(what do you know|what do you remember|what have you remembered|list|show|view|see|memory|memories)\b/.test(
        t,
      ));
  const hasCorrection = CORRECTION_RE.test(t);
  const noteText = t
    .replace(AMOUNT_GLOBAL_RE, " ")
    .replace(CORRECTION_GLOBAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasMerchantAmount = hasAmount && noteText.match(/[a-z]{2,}/i) !== null;
  const hasLogHint =
    hasAmount &&
    /\b(spent|paid|bought|got|grab|taxi|fare|gas|fuel|parking|toll|lunch|dinner|breakfast|coffee|snack|groceries|grocery|load|rent|netflix|subscription|salary|sweldo|income)\b/.test(
      t,
    );

  if (hasMemory && !/\b(recurring|remind|reminder)\b/.test(t)) {
    return selectMemoryProfile({
      hasMemoryRead,
      hasMemoryActionAndRead,
      hasMemoryManagement,
      hasMemoryRemember,
    });
  }
  if (hasRecurring && !hasMemory && !hasBudget && !hasGoal && !(hasRead && hasGeneralRead)) {
    return selectRecurringProfile({
      hasRecurringRead,
      hasRecurringActionAndRead,
      hasRecurringManagement,
      hasRecurringRemove,
      hasRecurringEdit,
    });
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
    hasLogHint || (hasCorrection && !hasGoal),
  ].filter(Boolean).length;

  // Mixed turns need the whole tool surface, e.g. "grab 180 and how am i doing" or
  // "set food budget 5k and how are my budgets".
  if (specificCount > 1) return "full";

  if (hasMemory) {
    return selectMemoryProfile({
      hasMemoryRead,
      hasMemoryActionAndRead,
      hasMemoryManagement,
      hasMemoryRemember,
    });
  }
  if (hasBudget) {
    if (hasBudgetRead) return "budgetRead";
    if (hasBudgetManagement && !hasAmount && !hasBudgetRemoveAndRead) return "budgetRemove";
    if (hasAmount && !hasBudgetWriteAndRead) return "budgetSet";
    return "budget";
  }
  if (hasRecurring) {
    return selectRecurringProfile({
      hasRecurringRead,
      hasRecurringActionAndRead,
      hasRecurringManagement,
      hasRecurringRemove,
      hasRecurringEdit,
    });
  }
  if (hasGoal) {
    if (hasGoalRead) return "goalRead";
    if (!hasCorrection && hasGoalManagement) return "goalManage";
    if (!hasCorrection && hasGoalContribution) return "goalContribute";
    if (!hasCorrection && hasGoalCreate) return "goalCreate";
    return "goal";
  }
  if (hasRead && !hasLogHint) return hasAnalysisRead ? "read" : "readBasic";
  if (hasCorrection && !hasMerchantAmount) return "logEdit";
  if (hasCorrection || (hasAmount && !hasMerchantAmount)) return "log";
  if (hasLogHint || hasMerchantAmount) return "logWrite";
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

function selectRecurringProfile({
  hasRecurringRead,
  hasRecurringActionAndRead,
  hasRecurringManagement,
  hasRecurringRemove,
  hasRecurringEdit,
}: {
  hasRecurringRead: boolean;
  hasRecurringActionAndRead: boolean;
  hasRecurringManagement: boolean;
  hasRecurringRemove: boolean;
  hasRecurringEdit: boolean;
}): ToolProfile {
  if (hasRecurringRead) return "recurringRead";
  if (hasRecurringActionAndRead) return "recurring";
  if (hasRecurringManagement) {
    if (hasRecurringRemove) return "recurringRemove";
    if (hasRecurringEdit) return "recurringEdit";
    return "recurring";
  }
  return "recurringAdd";
}

function selectMemoryProfile({
  hasMemoryRead,
  hasMemoryActionAndRead,
  hasMemoryManagement,
  hasMemoryRemember,
}: {
  hasMemoryRead: boolean;
  hasMemoryActionAndRead: boolean;
  hasMemoryManagement: boolean;
  hasMemoryRemember: boolean;
}): ToolProfile {
  if (hasMemoryActionAndRead) return "memory";
  if (hasMemoryRead) return "memoryRead";
  if (hasMemoryManagement) return "memoryForget";
  if (hasMemoryRemember) return "memoryRemember";
  return "memory";
}
