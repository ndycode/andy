export function pickRecurringMatch<T extends { label: string }>(
  rows: readonly T[],
  match: string,
): T | null {
  const q = match.trim().toLowerCase();
  if (!q) return null;
  return (
    rows.find((it) => it.label.toLowerCase() === q) ??
    rows.find((it) => it.label.toLowerCase().includes(q)) ??
    null
  );
}

export function addDaysToLocalDate(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export function matchGoals<T extends { name: string }>(
  goals: readonly T[],
  name: string,
): { kind: "none" } | { kind: "one"; goal: T } | { kind: "ambiguous"; goals: T[] } {
  const q = name.trim().toLowerCase();
  if (!q) return { kind: "none" };
  const exact = goals.find((g) => g.name.toLowerCase() === q);
  if (exact) return { kind: "one", goal: exact };
  const contains = goals.filter((g) => g.name.toLowerCase().includes(q));
  const [goal, secondGoal] = contains;
  if (!goal) return { kind: "none" };
  if (!secondGoal) return { kind: "one", goal };
  return { kind: "ambiguous", goals: contains };
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "at",
  "in",
  "on",
  "for",
  "to",
  "of",
  "my",
  "and",
  "with",
  "lunch",
  "dinner",
  "breakfast",
  "snack",
  "paid",
  "pay",
  "bought",
  "buy",
]);

export function noteKeywords(note: string): string[] {
  return [
    ...new Set(
      note
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w)),
    ),
  ];
}
