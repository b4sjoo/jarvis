import type { AdvisorContextReadScope } from "./advisor-context-read-scope.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import type {
  AdvisorEvidencePacket,
  AdvisorPromptContext,
  AdvisorSourceOwnedSemanticContext,
  TranscriptTurn,
} from "./types.js";

export interface SettledAdvisorContextCompilation {
  context: AdvisorPromptContext;
  scope: AdvisorContextReadScope;
  selectedSourceTurnIds: string[];
  recentSourceContextIncluded: boolean;
  rawTranscriptBypassRemoved: boolean;
}

export function compileSettledAdvisorPromptContext(input: {
  baseContext: AdvisorPromptContext;
  contextReadScope: AdvisorContextReadScope;
  logicalQuestionUnit?: LogicalQuestionUnit;
  transcriptTurns: TranscriptTurn[];
  recentSourceContext?: AdvisorSourceOwnedSemanticContext;
}): SettledAdvisorContextCompilation {
  const scope = input.contextReadScope;
  const task = input.baseContext.activeMeetingTask;
  const selectedIds = new Set(
    input.logicalQuestionUnit?.sourceTurnIds ?? []
  );
  const ownedContextIds = new Set(
    input.logicalQuestionUnit?.contextSourceTurnIds ?? []
  );
  for (const turnId of ownedContextIds) {
    selectedIds.add(turnId);
  }
  if (scope !== "current-only") {
    for (const turnId of input.recentSourceContext?.sourceTurnIds ?? []) {
      selectedIds.add(turnId);
    }
    for (const turnId of task?.parent.canonicalQuestionSourceTurnIds ?? []) {
      selectedIds.add(turnId);
    }
    if (scope === "active-child-read") {
      for (const turnId of task?.child?.basedOnTurnIds ?? []) {
        selectedIds.add(turnId);
      }
    }
  }

  const selectedTurns = input.transcriptTurns.filter(
    (turn) => selectedIds.has(turn.id) && turn.contextPromptEligible !== false
  );
  const currentQuestionText =
    input.baseContext.currentQuestionProjection?.answerFocusText?.trim() ||
    input.logicalQuestionUnit?.normalizedText.trim() ||
    "";
  const transcript = selectedTurns.length
    ? selectedTurns.map(formatTurn).join("\n")
    : currentQuestionText
      ? `Them: ${currentQuestionText}`
      : "";
  const selectedSourceTurnIds = selectedTurns.map((turn) => turn.id);
  const scopedTask = projectTaskForScope(
    input.baseContext.activeMeetingTask,
    scope
  );
  const currentScreenOwned = Boolean(
    input.logicalQuestionUnit?.currentTurnId.startsWith("screen:") ||
      (input.logicalQuestionUnit?.sourceTurnIds.length === 0 &&
        input.baseContext.activeMeetingTask?.screen)
  );
  const recentSourceContextOwnedByCurrentQuestion = Boolean(
    input.recentSourceContext?.sourceTurnIds.length &&
      input.recentSourceContext.sourceTurnIds.every((turnId) =>
        ownedContextIds.has(turnId)
      )
  );
  const authorizedRecentSourceContext =
    scope !== "current-only" || recentSourceContextOwnedByCurrentQuestion
      ? input.recentSourceContext
      : undefined;
  const advisorEvidencePacket = projectEvidencePacketForScope(
    input.baseContext.advisorEvidencePacket,
    scope,
    authorizedRecentSourceContext
  );

  return {
    scope,
    selectedSourceTurnIds,
    recentSourceContextIncluded: Boolean(
      ownedContextIds.size > 0 || authorizedRecentSourceContext
    ),
    rawTranscriptBypassRemoved:
      transcript !== input.baseContext.transcript,
    context: {
      ...input.baseContext,
      transcript,
      advisorPromptSourceTurnIds: selectedSourceTurnIds,
      latestTurn: selectedTurns.at(-1),
      screenContext: currentScreenOwned
        ? input.baseContext.screenContext
        : "",
      activeMeetingTask: scopedTask,
      rollingSummary:
        scope === "active-parent-read" || scope === "active-child-read"
          ? input.baseContext.rollingSummary
          : "",
      confirmedMeFacts:
        scope === "active-parent-read" || scope === "active-child-read"
          ? input.baseContext.confirmedMeFacts
          : undefined,
      responseOnlyParentReadContext:
        scope === "current-only"
          ? undefined
          : input.baseContext.responseOnlyParentReadContext,
      advisorEvidencePacket,
    },
  };
}

export function formatSettledAdvisorContextCompilationForTrace(
  compilation: SettledAdvisorContextCompilation
): Record<string, unknown> {
  return {
    settledAdvisorContextReadScope: compilation.scope,
    settledAdvisorContextSourceTurnIds:
      compilation.selectedSourceTurnIds,
    settledAdvisorContextSourceTurnCount:
      compilation.selectedSourceTurnIds.length,
    settledAdvisorRecentSourceContextIncluded:
      compilation.recentSourceContextIncluded,
    settledAdvisorRawTranscriptBypassRemoved:
      compilation.rawTranscriptBypassRemoved,
  };
}

function projectTaskForScope(
  task: AdvisorPromptContext["activeMeetingTask"],
  scope: AdvisorContextReadScope
) {
  if (!task || scope === "current-only") return undefined;
  if (scope === "active-parent-read") {
    return { ...task, child: undefined };
  }
  return task;
}

function projectEvidencePacketForScope(
  packet: AdvisorEvidencePacket | undefined,
  scope: AdvisorContextReadScope,
  recentSourceContext: AdvisorSourceOwnedSemanticContext | undefined
): AdvisorEvidencePacket | undefined {
  if (!packet) return undefined;
  return {
    ...packet,
    sourceOwnedSemanticContext: recentSourceContext,
    continuity:
      scope === "current-only" ? undefined : packet.continuity,
    generatedContinuity:
      scope === "bounded-recent-history"
        ? packet.generatedContinuity
        : undefined,
    retrievalHints: packet.retrievalHints.filter(
      (hint) =>
        hint.role !== "continuity" || scope !== "current-only"
    ),
  };
}

function formatTurn(turn: TranscriptTurn) {
  return `${turn.speaker === "me" ? "Me (clarification)" : "Them"}: ${turn.text}`;
}
