import type { NativeSpeechSegment } from "./audio-segment.js";

export interface RolloverTranscriptResult {
  status: "pending" | "ready" | "failed";
  text?: string;
  familyId?: string;
  segmentCount: number;
  failedSegmentCount: number;
  overlapRemovedChars: number;
  mergeUncertain: boolean;
  firstSpeechStartedAtMs: number;
  completedAtMs?: number;
  terminalOutcome?: RolloverTranscriptOutcome;
  degradedReason?: string;
}

export type RolloverTranscriptOutcome =
  | "success"
  | "empty"
  | "failed"
  | "cancelled";

interface TranscriptFamily {
  familyId: string;
  text: string;
  segmentCount: number;
  failedSegmentCount: number;
  overlapRemovedChars: number;
  mergeUncertain: boolean;
  firstSpeechStartedAtMs: number;
}

interface TokenSpan {
  normalized: string;
  end: number;
}

const tokenSpans = (value: string): TokenSpan[] => {
  const spans: TokenSpan[] = [];
  const expression = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) {
    spans.push({
      normalized: match[0].toLocaleLowerCase(),
      end: match.index + match[0].length,
    });
  }
  return spans;
};

export interface TranscriptMergeResult {
  text: string;
  overlapRemovedChars: number;
  uncertain: boolean;
}

export function mergeRolloverTranscripts(
  accumulated: string,
  next: string
): TranscriptMergeResult {
  const left = accumulated.trim();
  const right = next.trim();
  if (!left) {
    return { text: right, overlapRemovedChars: 0, uncertain: false };
  }
  if (!right) {
    return { text: left, overlapRemovedChars: 0, uncertain: true };
  }

  const leftTokens = tokenSpans(left);
  const rightTokens = tokenSpans(right);
  const limit = Math.min(leftTokens.length, rightTokens.length, 32);
  for (let count = limit; count >= 1; count -= 1) {
    const leftStart = leftTokens.length - count;
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      if (
        leftTokens[leftStart + index].normalized !==
        rightTokens[index].normalized
      ) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const removedChars = rightTokens[count - 1].end;
    const normalizedOverlapLength = rightTokens
      .slice(0, count)
      .reduce((length, token) => length + token.normalized.length, 0);
    if (count < 2 && normalizedOverlapLength < 8) continue;
    const remainder = right.slice(removedChars).trimStart();
    return {
      text: remainder ? `${left} ${remainder}` : left,
      overlapRemovedChars: removedChars,
      uncertain: false,
    };
  }

  return {
    text: `${left}\n${right}`,
    overlapRemovedChars: 0,
    uncertain: true,
  };
}

export class RolloverTranscriptAssembler {
  readonly #families = new Map<string, TranscriptFamily>();

  accept(input: {
    segment: NativeSpeechSegment;
    transcript: string;
    completedAtMs: number;
  }): RolloverTranscriptResult {
    return this.settle({
      segment: input.segment,
      outcome: input.transcript.trim() ? "success" : "empty",
      transcript: input.transcript,
      completedAtMs: input.completedAtMs,
    });
  }

  settle(input: {
    segment: NativeSpeechSegment;
    outcome: RolloverTranscriptOutcome;
    transcript?: string;
    completedAtMs: number;
  }): RolloverTranscriptResult {
    const familyId = input.segment.rolloverFamilyId;
    if (!familyId) {
      const text = input.transcript?.trim() ?? "";
      return {
        status: input.outcome === "success" && text ? "ready" : "failed",
        text: text || undefined,
        segmentCount: 1,
        failedSegmentCount: input.outcome === "success" ? 0 : 1,
        overlapRemovedChars: 0,
        mergeUncertain:
          input.segment.endReason === "forced-rollover" ||
          input.outcome !== "success",
        firstSpeechStartedAtMs: input.segment.speechStartedAtMs,
        completedAtMs: input.completedAtMs,
        terminalOutcome: input.outcome,
      };
    }

    const current = this.#families.get(familyId);
    const succeeded =
      input.outcome === "success" && Boolean(input.transcript?.trim());
    const merged = succeeded
      ? mergeRolloverTranscripts(current?.text ?? "", input.transcript ?? "")
      : {
          text: current?.text ?? "",
          overlapRemovedChars: 0,
          uncertain: true,
        };
    const family: TranscriptFamily = {
      familyId,
      text: merged.text,
      segmentCount: (current?.segmentCount ?? 0) + 1,
      failedSegmentCount:
        (current?.failedSegmentCount ?? 0) + (succeeded ? 0 : 1),
      overlapRemovedChars:
        (current?.overlapRemovedChars ?? 0) + merged.overlapRemovedChars,
      mergeUncertain: (current?.mergeUncertain ?? false) || merged.uncertain,
      firstSpeechStartedAtMs:
        current?.firstSpeechStartedAtMs ?? input.segment.speechStartedAtMs,
    };

    if (input.segment.endReason === "forced-rollover") {
      this.#families.set(familyId, family);
      return {
        status: "pending",
        familyId,
        segmentCount: family.segmentCount,
        failedSegmentCount: family.failedSegmentCount,
        overlapRemovedChars: family.overlapRemovedChars,
        mergeUncertain: family.mergeUncertain,
        firstSpeechStartedAtMs: family.firstSpeechStartedAtMs,
      };
    }

    this.#families.delete(familyId);
    const text = family.text.trim();
    const degradedReason = family.failedSegmentCount
      ? "rollover-family-member-unavailable"
      : undefined;
    return {
      status: text ? "ready" : "failed",
      text: text || undefined,
      familyId,
      segmentCount: family.segmentCount,
      failedSegmentCount: family.failedSegmentCount,
      overlapRemovedChars: family.overlapRemovedChars,
      mergeUncertain: family.mergeUncertain,
      firstSpeechStartedAtMs: family.firstSpeechStartedAtMs,
      completedAtMs: input.completedAtMs,
      terminalOutcome: input.outcome,
      degradedReason,
    };
  }

  abandonAll() {
    const abandoned = [...this.#families.values()].map((family) => ({
      familyId: family.familyId,
      segmentCount: family.segmentCount,
      failedSegmentCount: family.failedSegmentCount,
      overlapRemovedChars: family.overlapRemovedChars,
      mergeUncertain: true,
      firstSpeechStartedAtMs: family.firstSpeechStartedAtMs,
    }));
    this.#families.clear();
    return abandoned;
  }
}
