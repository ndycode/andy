export type PromptMemoryRow = {
  content: string;
  kind: string;
};

const QUERY_STOPWORDS = new Set([
  "about",
  "also",
  "andy",
  "can",
  "did",
  "for",
  "how",
  "into",
  "like",
  "make",
  "much",
  "now",
  "that",
  "the",
  "this",
  "til",
  "today",
  "what",
  "when",
  "with",
  "you",
]);

const MEMORY_KIND_RANK: Record<string, number> = {
  payday: 0,
  fact: 1,
  preference: 1,
  goal: 2,
  person: 3,
  other: 3,
};

export function shouldPromoteMemoryKind(current: string, next: string): boolean {
  return memoryKindRank(next) < memoryKindRank(current);
}

function memoryKindRank(kind: string): number {
  return MEMORY_KIND_RANK[kind] ?? 3;
}

const KEYWORD_ALIASES: Record<string, readonly string[]> = {
  boba: ["milktea"],
  paid: ["payday", "salary"],
  pay: ["payday"],
  salary: ["payday"],
  sweldo: ["payday", "salary"],
};

export function selectPromptMemories(
  rows: readonly PromptMemoryRow[],
  limit: number,
  query = "",
): string[] {
  const queryTokens = keywords(query);
  const seen = new Set<string>();
  const unique = rows.flatMap((r, index) => {
    const key = compactMemoryContent(r.content);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ row: r, index, relevance: relevanceScore(r.content, queryTokens) }];
  });

  unique.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      (MEMORY_KIND_RANK[a.row.kind] ?? 3) - (MEMORY_KIND_RANK[b.row.kind] ?? 3) ||
      a.index - b.index,
  );
  return unique.slice(0, limit).map((r) => r.row.content);
}

export function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function compactMemoryContent(content: string): string {
  return normalizeMemoryContent(content).replace(/\s+/g, "");
}

function relevanceScore(content: string, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const contentTokens = new Set(keywords(content));
  let score = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) score += 2;
  }
  return score;
}

function keywords(value: string): string[] {
  const base = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !QUERY_STOPWORDS.has(token));
  const expanded = new Set(base);

  for (const token of base) {
    for (const alias of KEYWORD_ALIASES[token] ?? []) {
      expanded.add(alias);
    }
  }

  for (let i = 0; i < base.length - 1; i++) {
    expanded.add(`${base[i]}${base[i + 1]}`);
  }

  return [...expanded];
}
