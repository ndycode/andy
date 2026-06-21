export type PromptMemoryRow = {
  content: string;
  kind: string;
};

const MEMORY_KIND_RANK: Record<string, number> = {
  payday: 0,
  fact: 1,
  preference: 1,
  goal: 2,
  person: 3,
  other: 3,
};

export function selectPromptMemories(rows: readonly PromptMemoryRow[], limit: number): string[] {
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = r.content.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => (MEMORY_KIND_RANK[a.kind] ?? 3) - (MEMORY_KIND_RANK[b.kind] ?? 3));
  return unique.slice(0, limit).map((r) => r.content);
}
