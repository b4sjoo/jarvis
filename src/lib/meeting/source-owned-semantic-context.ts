import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import type {
  AdvisorSourceOwnedSemanticContext,
  TranscriptTurn,
} from "./types.js";

export const SOURCE_OWNED_SETUP_MAX_AGE_MS = 45_000;
export const SOURCE_OWNED_SETUP_MAX_CHARS = 600;

export interface SourceOwnedSetupCandidate {
  sessionId: string;
  runtimeEpoch: number;
  turnId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  parentId: string;
  parentRevision: number;
  disposition: "append-setup";
  speechAct: Exclude<
    ReturnType<typeof projectPrimaryAsk>["speechAct"],
    "acknowledgement"
  >;
}

export interface SourceOwnedSemanticContextSelection {
  context?: AdvisorSourceOwnedSemanticContext;
  reason:
    | "selected-same-parent-adjacent-setup"
    | "no-candidate"
    | "candidate-is-current-source"
    | "session-mismatch"
    | "runtime-epoch-mismatch"
    | "active-parent-mismatch"
    | "candidate-expired"
    | "intervening-source-turn";
  consumeCandidate: boolean;
}

export function createSourceOwnedSetupCandidate(input: {
  turn: Pick<TranscriptTurn, "id" | "text" | "startedAt" | "endedAt">;
  sessionId: string;
  runtimeEpoch: number;
  activeMeetingTask?: ActiveMeetingTask;
}): SourceOwnedSetupCandidate | undefined {
  const projection = projectPrimaryAsk({
    turnId: input.turn.id,
    text: input.turn.text,
  });
  const parent = input.activeMeetingTask?.parent;
  if (
    !parent ||
    projection.disposition !== "append-setup" ||
    projection.speechAct === "acknowledgement"
  ) {
    return undefined;
  }
  return {
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    turnId: input.turn.id,
    text: input.turn.text.trim().slice(0, SOURCE_OWNED_SETUP_MAX_CHARS),
    startedAt: input.turn.startedAt,
    endedAt: input.turn.endedAt,
    parentId: parent.id,
    parentRevision: parent.revisions ?? 0,
    disposition: "append-setup",
    speechAct: projection.speechAct,
  };
}

export function selectSourceOwnedSemanticContext(input: {
  candidate?: SourceOwnedSetupCandidate;
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnit?: LogicalQuestionUnit;
  activeMeetingTask?: ActiveMeetingTask;
  transcriptTurns: TranscriptTurn[];
}): SourceOwnedSemanticContextSelection {
  const candidate = input.candidate;
  if (!candidate) {
    return { reason: "no-candidate", consumeCandidate: false };
  }
  if (input.logicalQuestionUnit?.sourceTurnIds.includes(candidate.turnId)) {
    return { reason: "candidate-is-current-source", consumeCandidate: false };
  }
  if (candidate.sessionId !== input.sessionId) {
    return { reason: "session-mismatch", consumeCandidate: true };
  }
  if (candidate.runtimeEpoch !== input.runtimeEpoch) {
    return { reason: "runtime-epoch-mismatch", consumeCandidate: true };
  }
  const parent = input.activeMeetingTask?.parent;
  if (!parent || parent.id !== candidate.parentId) {
    return { reason: "active-parent-mismatch", consumeCandidate: true };
  }
  const currentStartedAt = input.logicalQuestionUnit?.startedAt;
  if (
    currentStartedAt === undefined ||
    currentStartedAt < candidate.endedAt ||
    currentStartedAt - candidate.endedAt > SOURCE_OWNED_SETUP_MAX_AGE_MS
  ) {
    return { reason: "candidate-expired", consumeCandidate: true };
  }
  const latestEligiblePriorTurn = input.transcriptTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.endedAt <= currentStartedAt &&
        !input.logicalQuestionUnit?.sourceTurnIds.includes(turn.id) &&
        projectPrimaryAsk({ turnId: turn.id, text: turn.text }).speechAct !==
          "acknowledgement"
    )
    .sort((left, right) => right.endedAt - left.endedAt)[0];
  if (latestEligiblePriorTurn?.id !== candidate.turnId) {
    return { reason: "intervening-source-turn", consumeCandidate: true };
  }
  return {
    context: {
      text: candidate.text,
      sourceTurnIds: [candidate.turnId],
      parentId: parent.id,
      parentRevision: parent.revisions ?? 0,
      retentionReason: "same-parent-adjacent-setup",
    },
    reason: "selected-same-parent-adjacent-setup",
    consumeCandidate: true,
  };
}

export function formatSourceOwnedSemanticContextSelectionForTrace(
  candidate: SourceOwnedSetupCandidate | undefined,
  selection: SourceOwnedSemanticContextSelection
): Record<string, unknown> {
  return {
    sourceOwnedSetupCandidateTurnId: candidate?.turnId,
    sourceOwnedSetupCandidateSpeechAct: candidate?.speechAct,
    sourceOwnedSetupCandidateParentId: candidate?.parentId,
    sourceOwnedSetupSelectionReason: selection.reason,
    sourceOwnedSetupEnteredSemanticContext: Boolean(selection.context),
    sourceOwnedSetupSemanticContextChars: selection.context?.text.length ?? 0,
    sourceOwnedSetupCandidateConsumed: selection.consumeCandidate,
  };
}
