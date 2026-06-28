export type PromptMemoryRow = {
  content: string;
  kind: string;
};

const QUERY_STOPWORDS = new Set([
  "about",
  "also",
  "andy",
  "are",
  "can",
  "did",
  "does",
  "for",
  "have",
  "how",
  "into",
  "know",
  "like",
  "list",
  "make",
  "much",
  "now",
  "please",
  "remember",
  "show",
  "tell",
  "that",
  "the",
  "this",
  "til",
  "today",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
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

const PROFILE_QUERY_TOKENS = new Set([
  "address",
  "city",
  "home",
  "job",
  "live",
  "location",
  "office",
  "work",
]);

export function shouldPromoteMemoryKind(current: string, next: string): boolean {
  return memoryKindRank(next) < memoryKindRank(current);
}

function memoryKindRank(kind: string): number {
  return MEMORY_KIND_RANK[kind] ?? 3;
}

const KEYWORD_ALIASES: Record<string, readonly string[]> = {
  address: ["home", "live", "location", "city"],
  boba: ["milktea"],
  city: ["home", "live", "location", "address"],
  home: ["live", "address", "location", "city"],
  job: ["work", "office"],
  live: ["home", "address", "location", "city"],
  location: ["home", "live", "address", "city"],
  office: ["work", "job"],
  paid: ["payday", "salary"],
  pay: ["payday"],
  paycheck: ["payday", "salary"],
  salary: ["payday"],
  sweldo: ["payday", "salary"],
  work: ["office", "job"],
};

export function selectPromptMemories(
  rows: readonly PromptMemoryRow[],
  limit: number,
  query = "",
): string[] {
  const queryTokens = keywords(query);
  const profileLocationQuery = isProfileLocationQuery(query);
  const seen = new Set<string>();
  const unique = rows.flatMap((r, index) => {
    const key = compactMemoryContent(r.content);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        row: r,
        index,
        relevance: relevanceScore(r.content, r.kind, queryTokens, profileLocationQuery),
      },
    ];
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

function relevanceScore(
  content: string,
  kind: string,
  queryTokens: readonly string[],
  profileLocationQuery: boolean,
): number {
  if (queryTokens.length === 0) return 0;
  const contentTokens = new Set(keywords(content, false));
  let score = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) score += 2;
  }
  if (profileLocationQuery && kind === "person" && score > 0) {
    score += 3;
  }
  return score;
}

function isProfileLocationQuery(query: string): boolean {
  const tokens = new Set(keywords(query));
  if (![...tokens].some((token) => PROFILE_QUERY_TOKENS.has(token))) return false;
  return /\b(?:where|what(?:'s| is))\b/i.test(query);
}

function keywords(value: string, expandAliases = true): string[] {
  const base = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !QUERY_STOPWORDS.has(token));
  const expanded = new Set(base);

  if (expandAliases) {
    for (const token of base) {
      for (const alias of KEYWORD_ALIASES[token] ?? []) {
        expanded.add(alias);
      }
    }
  }

  for (let i = 0; i < base.length - 1; i++) {
    expanded.add(`${base[i]}${base[i + 1]}`);
  }

  return [...expanded];
}
