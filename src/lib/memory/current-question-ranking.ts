import type { MemoryEntry } from "./types.js";

export interface CurrentQuestionRankingBoost {
  score: number;
  titleMatches: number;
  tagMatches: number;
  keywordMatches: number;
  contentMatches: number;
}

export function scoreCurrentQuestionRelevance(
  entry: MemoryEntry,
  currentQuestionTokens: Set<string>
): CurrentQuestionRankingBoost {
  const titleMatches = countTokenOverlap(
    currentQuestionTokens,
    tokenize(entry.title)
  );
  const tagMatches = countTokenOverlap(
    currentQuestionTokens,
    tokenize(entry.tags.join(" "))
  );
  const keywordMatches = countTokenOverlap(
    currentQuestionTokens,
    tokenize(entry.keywords.join(" "))
  );
  const contentMatches = countTokenOverlap(
    currentQuestionTokens,
    tokenize(
      [entry.summary, entry.content.slice(0, 600)]
        .filter(Boolean)
        .join(" ")
    )
  );
  return {
    score:
      titleMatches * 12 +
      tagMatches * 14 +
      keywordMatches * 10 +
      Math.min(contentMatches * 4, 24),
    titleMatches,
    tagMatches,
    keywordMatches,
    contentMatches,
  };
}

function tokenize(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9+#.]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

function countTokenOverlap(left: Set<string>, right: Set<string>) {
  let matches = 0;
  for (const token of left) {
    if (right.has(token)) matches += 1;
  }
  return matches;
}
