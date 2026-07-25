export interface RolloverTranscriptDeduplication {
  text: string;
  changed: boolean;
  overlapTokenCount: number;
  reason:
    | "no-previous-transcript"
    | "no-reliable-token-overlap"
    | "leading-overlap-removed"
    | "entire-transcript-overlap";
}

interface TranscriptToken {
  normalized: string;
  end: number;
}

const MAX_ROLLOVER_OVERLAP_TOKENS = 16;

export function deduplicateRolloverTranscript(
  previousText: string,
  currentText: string
): RolloverTranscriptDeduplication {
  const previousTokens = tokenize(previousText);
  const currentTokens = tokenize(currentText);
  if (previousTokens.length === 0 || currentTokens.length === 0) {
    return {
      text: currentText,
      changed: false,
      overlapTokenCount: 0,
      reason: "no-previous-transcript",
    };
  }

  const maximum = Math.min(
    MAX_ROLLOVER_OVERLAP_TOKENS,
    previousTokens.length,
    currentTokens.length
  );
  let overlapTokenCount = 0;
  for (let count = maximum; count >= 1; count -= 1) {
    const previousStart = previousTokens.length - count;
    const matches = currentTokens
      .slice(0, count)
      .every(
        (token, index) =>
          token.normalized ===
          previousTokens[previousStart + index]?.normalized
      );
    if (!matches) continue;

    const reliableSingleToken =
      count === 1 && currentTokens[0]!.normalized.length >= 6;
    if (count >= 2 || reliableSingleToken) {
      overlapTokenCount = count;
      break;
    }
  }

  if (overlapTokenCount === 0) {
    return {
      text: currentText,
      changed: false,
      overlapTokenCount: 0,
      reason: "no-reliable-token-overlap",
    };
  }

  const overlapEnd = currentTokens[overlapTokenCount - 1]!.end;
  const text = currentText
    .slice(overlapEnd)
    .replace(/^[\s,.;:!?()[\]{}"'`-]+/u, "")
    .trimStart();
  return {
    text,
    changed: true,
    overlapTokenCount,
    reason: text
      ? "leading-overlap-removed"
      : "entire-transcript-overlap",
  };
}

function tokenize(text: string): TranscriptToken[] {
  const tokens: TranscriptToken[] = [];
  const matcher = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  for (const match of text.matchAll(matcher)) {
    tokens.push({
      normalized: match[0]!.toLocaleLowerCase(),
      end: (match.index ?? 0) + match[0]!.length,
    });
  }
  return tokens;
}
