/** Best-effort one-liner from a read tool's structured output, for the no-final-text path. */
export function summarizeReadResult(output: unknown): string {
  if (isRecord(output)) {
    const o = output;
    // When the read was scoped to a past month, attribute the figure to THAT month, not "this month".
    const month = stringField(o, "month");
    const period = month ? `in ${month}` : "so far this month";
    // getPeriodSpending: { period: 'today'|'week', total, category|null }. Check BEFORE the
    // getSpending branch below because its category can be null and it carries a period discriminator.
    const total = stringField(o, "total");
    const category = o.category;
    const periodScope = o.period;
    if (
      total &&
      (periodScope === "today" || periodScope === "week") &&
      (typeof category === "string" || category === null)
    ) {
      const span = periodScope === "today" ? "today" : "this week";
      const scope = typeof category === "string" ? `${category}: ` : "";
      return `${scope}${total} ${span}.`;
    }
    if (total && typeof category === "string") {
      return `${category}: ${total} ${period}.`;
    }
    const income = stringField(o, "income");
    const expenses = stringField(o, "expenses");
    const net = stringField(o, "net");
    if (income && expenses && net) {
      const overviewPeriod = month ? `in ${month}` : "this month";
      return `in ${income}, out ${expenses}, net ${net} ${overviewPeriod}.`;
    }
    if (Array.isArray(o.breakdown)) {
      const top = compact(rowRecords(o.breakdown).map(formatBreakdownRow)).slice(0, 3).join(", ");
      return top ? `top categories: ${top}.` : "nothing logged yet this month.";
    }
    if (Array.isArray(o.goals)) {
      const g = stringArray(o.goals);
      return g.length ? g.map(String).join(" · ") : "no savings goals yet.";
    }
    if (Array.isArray(o.remembered)) {
      const m = stringArray(o.remembered);
      return m.length
        ? `here's what i know:\n${m.map((x) => `- ${x}`).join("\n")}`
        : "nothing saved yet.";
    }
    if (Array.isArray(o.transactions)) {
      const top = compact(rowRecords(o.transactions).map(formatTransactionRow))
        .slice(0, 5)
        .join(", ");
      return top ? `recent: ${top}.` : "nothing logged yet.";
    }
    if (Array.isArray(o.recurring)) {
      const top = compact(rowRecords(o.recurring).map(formatRecurringRow)).join(", ");
      return top ? `recurring: ${top}.` : "no recurring bills set up.";
    }
    if (Array.isArray(o.budgets)) {
      const top = compact(rowRecords(o.budgets).map(formatBudgetRow)).join(", ");
      return top ? `budgets: ${top}.` : "no budgets set up.";
    }
    const direction = stringField(o, "direction");
    const current = stringField(o, "current");
    const previous = stringField(o, "previous");
    if (direction && current && previous) {
      const pctChange = numberField(o, "pctChange");
      const pct = pctChange === null ? "" : ` (${pctChange > 0 ? "+" : ""}${pctChange}%)`;
      const word = direction === "up" ? "up" : direction === "down" ? "down" : "flat";
      return `${stringField(o, "scope") ?? "spending"}: ${current} now vs ${previous} before, ${word}${pct}.`;
    }
    const projectedMonthEnd = stringField(o, "projectedMonthEnd");
    const spentSoFar = stringField(o, "spentSoFar");
    const budget = stringField(o, "budget");
    if (projectedMonthEnd && spentSoFar && typeof category === "string") {
      const head = `${category}: ${spentSoFar} so far, on pace for ${projectedMonthEnd} by month end`;
      const projectedOver = stringField(o, "projectedOver");
      if (booleanField(o, "onTrackToExceed") && projectedOver && budget) {
        return `${head} — that's ${projectedOver} over your ${budget} budget 👀`;
      }
      return budget ? `${head}, within your ${budget} budget.` : `${head}.`;
    }
    const weekend = stringField(o, "weekend");
    const weekday = stringField(o, "weekday");
    if (weekend && weekday) {
      const leak = formatLeak(o.topLeak);
      const leakStr = leak ? ` biggest leak: ${leak}.` : "";
      return `weekday ${weekday}, weekend ${weekend}.${leakStr}`;
    }
  }
  return "here's what i found.";
}

type SummaryRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SummaryRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: SummaryRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: SummaryRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function booleanField(record: SummaryRecord, key: string): boolean {
  return record[key] === true;
}

function rowRecords(value: unknown): readonly SummaryRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function compact(values: readonly (string | null)[]): readonly string[] {
  return values.filter((value) => value !== null);
}

function formatBreakdownRow(row: SummaryRecord): string | null {
  const category = stringField(row, "category");
  const total = stringField(row, "total");
  return category && total ? `${category} ${total}` : null;
}

function formatTransactionRow(row: SummaryRecord): string | null {
  const amount = stringField(row, "amount");
  const label = stringField(row, "note") ?? stringField(row, "category");
  return amount && label ? `${amount} ${label}` : null;
}

function formatRecurringRow(row: SummaryRecord): string | null {
  const label = stringField(row, "label");
  const amount = stringField(row, "amount");
  return label && amount ? `${label} ${amount}` : null;
}

function formatBudgetRow(row: SummaryRecord): string | null {
  const category = stringField(row, "category");
  const spent = stringField(row, "spent");
  const limit = stringField(row, "limit");
  const pct = numberField(row, "pct");
  return category && spent && limit && pct !== null
    ? `${category} ${spent}/${limit} (${pct}%)`
    : null;
}

function formatLeak(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const what = stringField(value, "what");
  const total = stringField(value, "total");
  return what && total ? `${what} ${total}` : null;
}
