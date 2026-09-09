import type { AdvisorContextReadScope } from "./advisor-context-read-scope.js";
import type { LogicalQuestionUnit } from "./logical-question-unit.js";
import {
  projectAdvisorTranscriptForLogicalQuestion,
  type AdvisorTranscriptProjection,
  type EffectiveLogicalQuestionModelRecord,
} from "./logical-question-effective-projection.js";
import type { ScreenScopeDecision } from "./screen-task-scope.js";
import type {
  AdvisorContextScopeSnapshot,
  AdvisorEvidencePacket,
  AdvisorPromptContext,
  AdvisorSourceOwnedSemanticContext,
  TranscriptTurn,
} from "./types.js";

export type SettledResponseActionContextSelectionReason =
  | "no-response-action-context-receipt"
  | "logical-question-missing"
  | "logical-question-unit-mismatch"
  | "logical-question-revision-mismatch"
  | "context-scope-mode-mismatch"
  | "current-source-missing"
  | "authorized";

export interface SettledResponseActionContextSelection {
  requested: boolean;
  authorized: boolean;
  reason: SettledResponseActionContextSelectionReason;
  contextReadScope?: Extract<
    AdvisorContextReadScope,
    "current-only" | "bounded-recent-history"
  >;
  selectedSourceTurnIds: string[];
  operationId?: string;
  action?: AdvisorContextScopeSnapshot["action"];
}

export interface SettledAdvisorContextCompilation {
  context: AdvisorPromptContext;
  transcriptProjection: AdvisorTranscriptProjection;
  scope: AdvisorContextReadScope;
  selectedSourceTurnIds: string[];
  recentSourceContextIncluded: boolean;
  rawTranscriptBypassRemoved: boolean;
  screenContextIncluded: boolean;
  screenContextReason:
    | "current-screen-source"
    | "settled-screen-scope-keep"
    | "screen-scope-clear"
    | "context-scope-current-only"
    | "settled-screen-owner-missing";
  responseActionContextSelectionApplied: boolean;
  responseActionContextSelectionReason:
    SettledResponseActionContextSelectionReason;
}

export function resolveSettledResponseActionContextSelection(input: {
  snapshot?: AdvisorContextScopeSnapshot;
  logicalQuestionUnit?: LogicalQuestionUnit;
}): SettledResponseActionContextSelection {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return {
      requested: false,
      authorized: false,
      reason: "no-response-action-context-receipt",
      selectedSourceTurnIds: [],
    };
  }
  const rejected = (
    reason: Exclude<SettledResponseActionContextSelectionReason, "authorized">
  ): SettledResponseActionContextSelection => ({
    requested: true,
    authorized: false,
    reason,
    selectedSourceTurnIds: [],
    operationId: snapshot.operationId,
    action: snapshot.action,
  });
  const logicalQuestionUnit = input.logicalQuestionUnit;
  if (!logicalQuestionUnit) return rejected("logical-question-missing");
  if (snapshot.logicalQuestionUnitId !== logicalQuestionUnit.id) {
    return rejected("logical-question-unit-mismatch");
  }
  if (snapshot.logicalQuestionUnitRevision !== logicalQuestionUnit.revision) {
    return rejected("logical-question-revision-mismatch");
  }
  const expectedMode =
    snapshot.action === "narrow-context" ? "current-only" : "expanded";
  if (snapshot.mode !== expectedMode) {
    return rejected("context-scope-mode-mismatch");
  }
  const selectedSourceTurnIds = uniqueStrings(
    snapshot.selectedContextTurnIds
  );
  if (
    logicalQuestionUnit.sourceTurnIds.some(
      (turnId) => !selectedSourceTurnIds.includes(turnId)
    )
  ) {
    return rejected("current-source-missing");
  }
  return {
    requested: true,
    authorized: true,
    reason: "authorized",
    contextReadScope:
      snapshot.action === "narrow-context"
        ? "current-only"
        : "bounded-recent-history",
    selectedSourceTurnIds,
    operationId: snapshot.operationId,
    action: snapshot.action,
  };
}

export function formatSettledResponseActionContextSelectionForTrace(
  selection: SettledResponseActionContextSelection
): Record<string, unknown> {
  return {
    settledResponseActionContextSelectionRequested: selection.requested,
    settledResponseActionContextSelectionAuthorized: selection.authorized,
    settledResponseActionContextSelectionReason: selection.reason,
    settledResponseActionContextSelectionOperationId: selection.operationId,
    settledResponseActionContextSelectionAction: selection.action,
    settledResponseActionContextSelectionScope: selection.contextReadScope,
    settledResponseActionContextSelectionSourceTurnIds:
      selection.selectedSourceTurnIds,
  };
}

export function compileSettledAdvisorPromptContext(input: {
  baseContext: AdvisorPromptContext;
  contextReadScope: AdvisorContextReadScope;
  logicalQuestionUnit?: LogicalQuestionUnit;
  transcriptTurns: TranscriptTurn[];
  effectiveRecords?: EffectiveLogicalQuestionModelRecord[];
  sessionId?: string;
  runtimeEpoch?: number;
  recentSourceContext?: AdvisorSourceOwnedSemanticContext;
  screenScopeDecision?: Pick<ScreenScopeDecision, "action" | "reason">;
  responseActionContextSelection?: SettledResponseActionContextSelection;
}): SettledAdvisorContextCompilation {
  const responseActionContextSelection =
    input.responseActionContextSelection ??
    resolveSettledResponseActionContextSelection({
      snapshot: input.baseContext.responseActionContextScope,
      logicalQuestionUnit: input.logicalQuestionUnit,
    });
  const scope =
    responseActionContextSelection.authorized &&
    responseActionContextSelection.contextReadScope
      ? responseActionContextSelection.contextReadScope
      : input.contextReadScope;
  const task = input.baseContext.activeMeetingTask;
  const selectedIds = new Set(
    responseActionContextSelection.authorized
      ? responseActionContextSelection.selectedSourceTurnIds
      : input.logicalQuestionUnit?.sourceTurnIds ?? []
  );
  const ownedContextIds = new Set(
    input.logicalQuestionUnit?.contextSourceTurnIds ?? []
  );
  const recentLogicalQuestionSourceTurnIds =
    input.logicalQuestionUnit?.recentLogicalQuestionSourceTurnIds ?? [];
  if (!responseActionContextSelection.authorized) {
    for (const turnId of ownedContextIds) {
      selectedIds.add(turnId);
    }
  }
  if (!responseActionContextSelection.authorized && scope !== "current-only") {
    for (const turnId of recentLogicalQuestionSourceTurnIds) {
      selectedIds.add(turnId);
    }
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
  const transcriptProjection = projectAdvisorTranscriptForLogicalQuestion({
    turns: selectedTurns,
    logicalQuestionUnit: input.logicalQuestionUnit,
    effectiveRecords: input.effectiveRecords,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    meTurnLabel: "Me (clarification)",
  });
  const transcript = selectedTurns.length
    ? transcriptProjection.transcript
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
  const screenContextDecision = resolveSettledScreenContext({
    currentScreenOwned,
    contextReadScope: scope,
    screenScopeDecision: input.screenScopeDecision,
    settledTask: scopedTask,
  });
  const recentSourceContextOwnedByCurrentQuestion = Boolean(
    input.recentSourceContext?.sourceTurnIds.length &&
      input.recentSourceContext.sourceTurnIds.every((turnId) =>
        ownedContextIds.has(turnId)
      )
  );
  const authorizedRecentSourceContext =
    responseActionContextSelection.authorized
      ? input.recentSourceContext?.sourceTurnIds.every((turnId) =>
          selectedIds.has(turnId)
        )
        ? input.recentSourceContext
        : undefined
      : scope !== "current-only" || recentSourceContextOwnedByCurrentQuestion
        ? input.recentSourceContext
        : undefined;
  const contextCandidateIds = new Set([
    ...ownedContextIds,
    ...recentLogicalQuestionSourceTurnIds,
    ...(authorizedRecentSourceContext?.sourceTurnIds ?? []),
  ]);
  const advisorEvidencePacket = projectEvidencePacketForScope(
    input.baseContext.advisorEvidencePacket,
    scope,
    authorizedRecentSourceContext
  );

  return {
    scope,
    transcriptProjection,
    selectedSourceTurnIds,
    recentSourceContextIncluded: Boolean(
      selectedSourceTurnIds.some((turnId) => contextCandidateIds.has(turnId))
    ),
    rawTranscriptBypassRemoved:
      transcript !== input.baseContext.transcript,
    screenContextIncluded: screenContextDecision.included,
    screenContextReason: screenContextDecision.reason,
    responseActionContextSelectionApplied:
      responseActionContextSelection.authorized,
    responseActionContextSelectionReason:
      responseActionContextSelection.reason,
    context: {
      ...input.baseContext,
      transcript,
      advisorPromptSourceTurnIds: selectedSourceTurnIds,
      latestTurn: transcriptProjection.latestTurn,
      screenContext: screenContextDecision.included
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
    settledAdvisorScreenContextIncluded:
      compilation.screenContextIncluded,
    settledAdvisorScreenContextReason:
      compilation.screenContextReason,
    settledAdvisorResponseActionContextSelectionApplied:
      compilation.responseActionContextSelectionApplied,
    settledAdvisorResponseActionContextSelectionReason:
      compilation.responseActionContextSelectionReason,
  };
}

function resolveSettledScreenContext(input: {
  currentScreenOwned: boolean;
  contextReadScope: AdvisorContextReadScope;
  screenScopeDecision?: Pick<ScreenScopeDecision, "action" | "reason">;
  settledTask: AdvisorPromptContext["activeMeetingTask"];
}): {
  included: boolean;
  reason: SettledAdvisorContextCompilation["screenContextReason"];
} {
  if (input.currentScreenOwned) {
    return { included: true, reason: "current-screen-source" };
  }
  if (input.screenScopeDecision?.action === "clear") {
    return { included: false, reason: "screen-scope-clear" };
  }
  if (input.contextReadScope === "current-only") {
    return { included: false, reason: "context-scope-current-only" };
  }
  if (
    input.screenScopeDecision?.action === "keep" &&
    input.settledTask?.screen
  ) {
    return { included: true, reason: "settled-screen-scope-keep" };
  }
  return { included: false, reason: "settled-screen-owner-missing" };
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

function uniqueStrings(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
