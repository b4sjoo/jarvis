export type StagedAnswerPartialReason =
  | "guardrail-held"
  | "legacy-empty-surface"
  | "legacy-stable-answer-held"
  | "explicit-waiting-valid-section"
  | "explicit-first-valid-section"
  | "explicit-stream-continued";

export interface StagedAnswerPartialDecision {
  visible: boolean;
  startsVisibleStream: boolean;
  reason: StagedAnswerPartialReason;
}

const MEETING_SECTION_PATTERN =
  /(?:^|\n)\s*(?:中文思路|Question|Answer|Approach|Code|Complexity|Whiteboard|Clarifying question|Clarifying options)\s*:\s*([\s\S]*)$/im;

export function decideStagedAnswerPartial(input: {
  accumulated: string;
  explicitRequest: boolean;
  automaticVoiceAuthorized?: boolean;
  stableAnswerPresent: boolean;
  guardrailHeld: boolean;
  visibleStreamStarted: boolean;
}): StagedAnswerPartialDecision {
  if (input.guardrailHeld) {
    return {
      visible: false,
      startsVisibleStream: false,
      reason: "guardrail-held",
    };
  }

  const streamingAuthorized =
    input.explicitRequest || input.automaticVoiceAuthorized === true;
  if (!streamingAuthorized) {
    return input.stableAnswerPresent
      ? {
          visible: false,
          startsVisibleStream: false,
          reason: "legacy-stable-answer-held",
        }
      : {
          visible: true,
          startsVisibleStream: false,
          reason: "legacy-empty-surface",
        };
  }

  if (input.visibleStreamStarted) {
    return {
      visible: true,
      startsVisibleStream: false,
      reason: "explicit-stream-continued",
    };
  }

  if (!input.stableAnswerPresent || hasDisplayableMeetingSection(input.accumulated)) {
    return {
      visible: true,
      startsVisibleStream: input.stableAnswerPresent,
      reason: "explicit-first-valid-section",
    };
  }

  return {
    visible: false,
    startsVisibleStream: false,
    reason: "explicit-waiting-valid-section",
  };
}

export function hasDisplayableMeetingSection(value: string) {
  const match = MEETING_SECTION_PATTERN.exec(value);
  if (!match) return false;
  return match[1].replace(/[`*_#>-]/g, "").trim().length >= 4;
}

export function projectStagedAnswerOnlyContent(value: string) {
  const artifactBoundary =
    /(?:^|\n)\s*(?:Code|Complexity|Whiteboard)\s*:/gim;
  const match = artifactBoundary.exec(value);
  return (match ? value.slice(0, match.index) : value).trimEnd();
}

export function formatStagedAnswerDeliveryForTrace(input: {
  explicitRequest: boolean;
  automaticVoiceAuthorized?: boolean;
  chunkCount: number;
  firstChunkAt?: number;
  firstVisiblePartialAt?: number;
  visibleStreamStarted: boolean;
  rollbackReason?: string;
}) {
  return {
    stagedAnswerDeliveryExplicitRequest: input.explicitRequest,
    stagedAnswerDeliveryAutomaticVoiceAuthorized:
      input.automaticVoiceAuthorized ?? false,
    stagedAnswerDeliveryChunkCount: input.chunkCount,
    stagedAnswerDeliveryFirstChunkAt: input.firstChunkAt,
    stagedAnswerDeliveryFirstVisiblePartialAt: input.firstVisiblePartialAt,
    stagedAnswerDeliveryVisibleStreamStarted: input.visibleStreamStarted,
    stagedAnswerDeliveryRollbackReason: input.rollbackReason,
  };
}
