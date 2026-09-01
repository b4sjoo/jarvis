import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import { isExplicitMeetingLogisticsTranscript } from "./meeting-logistics.js";
import { projectPrimaryAsk } from "./primary-ask-projection.js";
import type {
  AdvisorSourceOwnedSemanticContext,
  TranscriptTurn,
} from "./types.js";

export const SOURCE_OWNED_SETUP_MAX_AGE_MS = 45_000;
export const SOURCE_OWNED_SETUP_MAX_CHARS = 600;
export const SOURCE_OWNED_SETUP_MAX_SOURCES = 8;

export interface SourceOwnedSetupSource {
  turnId: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

export interface SourceOwnedSetupCandidate {
  sessionId: string;
  runtimeEpoch: number;
  turnId: string;
  sourceTurnIds: string[];
  sources: SourceOwnedSetupSource[];
  text: string;
  startedAt: number;
  endedAt: number;
  parentId?: string;
  parentRevision?: number;
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
    | "selected-recent-source-context"
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
  if (
    projection.disposition !== "append-setup" ||
    isExcludedSourceContextTurn(input.turn.text, projection.speechAct)
  ) {
    return undefined;
  }
  const parent = input.activeMeetingTask?.parent;
  const source = {
    turnId: input.turn.id,
    text: input.turn.text.trim(),
    startedAt: input.turn.startedAt,
    endedAt: input.turn.endedAt,
  };
  return {
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    turnId: input.turn.id,
    sourceTurnIds: [input.turn.id],
    sources: [source],
    text: boundSourceContextText([source]),
    startedAt: input.turn.startedAt,
    endedAt: input.turn.endedAt,
    parentId: parent?.id,
    parentRevision: parent?.revisions ?? undefined,
    disposition: "append-setup",
    speechAct: projection.speechAct as SourceOwnedSetupCandidate["speechAct"],
  };
}

export function appendSourceOwnedSetupCandidate(
  current: SourceOwnedSetupCandidate | undefined,
  next: SourceOwnedSetupCandidate
): SourceOwnedSetupCandidate {
  if (
    !current ||
    current.sessionId !== next.sessionId ||
    current.runtimeEpoch !== next.runtimeEpoch ||
    current.parentId !== next.parentId ||
    next.startedAt < current.endedAt ||
    next.startedAt - current.endedAt > SOURCE_OWNED_SETUP_MAX_AGE_MS
  ) {
    return cloneCandidate(next);
  }
  const sources = dedupeSources([...current.sources, ...next.sources]).slice(
    -SOURCE_OWNED_SETUP_MAX_SOURCES
  );
  return {
    ...next,
    sourceTurnIds: sources.map((source) => source.turnId),
    sources,
    text: boundSourceContextText(sources),
    startedAt: sources[0]?.startedAt ?? next.startedAt,
    endedAt: sources.at(-1)?.endedAt ?? next.endedAt,
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
  if (candidate.sessionId !== input.sessionId) {
    return { reason: "session-mismatch", consumeCandidate: true };
  }
  if (candidate.runtimeEpoch !== input.runtimeEpoch) {
    return { reason: "runtime-epoch-mismatch", consumeCandidate: true };
  }
  const parent = input.activeMeetingTask?.parent;
  if (candidate.parentId && parent?.id !== candidate.parentId) {
    return { reason: "active-parent-mismatch", consumeCandidate: true };
  }
  const currentStartedAt = input.logicalQuestionUnit?.startedAt;
  const currentSourceIds = new Set(
    input.logicalQuestionUnit?.sourceTurnIds ?? []
  );
  const eligibleSources = candidate.sources.filter(
    (source) =>
      !currentSourceIds.has(source.turnId) &&
      currentStartedAt !== undefined &&
      source.endedAt <= currentStartedAt
  );
  if (!eligibleSources.length) {
    return { reason: "candidate-is-current-source", consumeCandidate: true };
  }
  const latestContextSource = eligibleSources.at(-1);
  if (
    currentStartedAt === undefined ||
    !latestContextSource ||
    currentStartedAt - latestContextSource.endedAt >
      SOURCE_OWNED_SETUP_MAX_AGE_MS
  ) {
    return { reason: "candidate-expired", consumeCandidate: true };
  }
  const latestEligiblePriorTurn = input.transcriptTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.endedAt <= currentStartedAt &&
        !currentSourceIds.has(turn.id) &&
        !isExcludedSourceContextTurn(
          turn.text,
          projectPrimaryAsk({ turnId: turn.id, text: turn.text }).speechAct
        )
    )
    .sort((left, right) => right.endedAt - left.endedAt)[0];
  if (
    latestEligiblePriorTurn?.id !== latestContextSource.turnId &&
    !candidate.sourceTurnIds.includes(latestEligiblePriorTurn?.id ?? "")
  ) {
    return { reason: "intervening-source-turn", consumeCandidate: true };
  }
  return {
    context: {
      text: boundSourceContextText(eligibleSources),
      sourceTurnIds: eligibleSources.map((source) => source.turnId),
      parentId: parent?.id,
      parentRevision: parent?.revisions,
      retentionReason: parent
        ? "same-parent-adjacent-setup"
        : "recent-source-context",
    },
    reason: parent
      ? "selected-same-parent-adjacent-setup"
      : "selected-recent-source-context",
    consumeCandidate: true,
  };
}

export function formatSourceOwnedSemanticContextSelectionForTrace(
  candidate: SourceOwnedSetupCandidate | undefined,
  selection: SourceOwnedSemanticContextSelection
): Record<string, unknown> {
  return {
    sourceOwnedSetupCandidateTurnId: candidate?.turnId,
    sourceOwnedSetupCandidateTurnIds: candidate?.sourceTurnIds,
    sourceOwnedSetupCandidateSpeechAct: candidate?.speechAct,
    sourceOwnedSetupCandidateParentId: candidate?.parentId,
    sourceOwnedSetupSelectionReason: selection.reason,
    sourceOwnedSetupEnteredSemanticContext: Boolean(selection.context),
    sourceOwnedSetupSemanticContextChars: selection.context?.text.length ?? 0,
    sourceOwnedSetupCandidateConsumed: selection.consumeCandidate,
  };
}

function cloneCandidate(
  candidate: SourceOwnedSetupCandidate
): SourceOwnedSetupCandidate {
  return {
    ...candidate,
    sourceTurnIds: [...candidate.sourceTurnIds],
    sources: candidate.sources.map((source) => ({ ...source })),
  };
}

function dedupeSources(sources: SourceOwnedSetupSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.turnId)) return false;
    seen.add(source.turnId);
    return true;
  });
}

function boundSourceContextText(sources: SourceOwnedSetupSource[]) {
  const joined = sources
    .map((source) => source.text.trim())
    .filter(Boolean)
    .join(" ");
  if (joined.length <= SOURCE_OWNED_SETUP_MAX_CHARS) return joined;
  const head = joined.slice(0, 200).trimEnd();
  const tail = joined
    .slice(-(SOURCE_OWNED_SETUP_MAX_CHARS - head.length - 5))
    .trimStart();
  return `${head} ... ${tail}`;
}

function isExcludedSourceContextTurn(
  text: string,
  speechAct: ReturnType<typeof projectPrimaryAsk>["speechAct"]
) {
  return (
    speechAct === "acknowledgement" ||
    (speechAct === "logistics" && isExplicitMeetingLogisticsTranscript(text))
  );
}
