import type { ActiveMeetingTask } from './meeting-task-contracts.js';
import type { CanonicalQuestionType } from './task-taxonomy.js';
import type { CurrentQuestionSettlementProposal, ProvisionalCurrentQuestion } from './current-question-settlement.js';
import { createOrderedSettlementDeadline, createOrderedRelationPhaseBudget, createOrderedRelationCanonicalDeadline,
  readOrderedSettlementRemainingMs, resolveOrderedRelationOperationTerminal,
  type OrderedSettlementDeadline } from './ordered-settlement-coordinator.js';
import { ORDERED_RELATION_STAGE_BUDGET_MS, filterTaskRelationAffinityOutcomeAtCutoff,
  decideOrderedTaskRelationResolution, formatOrderedTaskRelationResolutionForTrace,
  type TaskRelationSplitAffinityOutcome, type TaskRelationCanonicalShadowAdjudication } from './task-relation-split-shadow.js';

export interface TaskRelationAdjudicationScheduleHandle {
  releaseWindowRequested: boolean;
  affinityDeadlineAt?: number;
  operationId?: string;
  // Stage terminal: settled once by the stage owner, at the stage deadline at the latest.
  affinityOutcome?: Promise<TaskRelationSplitAffinityOutcome>;
  readAffinityOutcome?: () => TaskRelationSplitAffinityOutcome;
  revalidateAffinityOutcome?: (
    outcome: TaskRelationSplitAffinityOutcome
  ) => TaskRelationSplitAffinityOutcome;
  authorizeOperation: () => TaskRelationOperationAuthorization;
  canonicalOutcome?: Promise<TaskRelationSplitCanonicalResult>;
  startCanonical?: (
    input: {
      foreground: boolean;
      affinityOutcome?: TaskRelationSplitAffinityOutcome;
      deadlineAt?: number;
    }
  ) => Promise<TaskRelationSplitCanonicalResult>;
  cancelForegroundWork?: () => void;
  currentQuestion?: ProvisionalCurrentQuestion;
  deterministicProposal?: CurrentQuestionSettlementProposal;
  localQuestionType?: CanonicalQuestionType;
  sourceKind?: "voice" | "screen" | "mixed";
}

export interface TaskRelationOperationAuthorization {
  authorized: boolean;
  reason: string;
  mismatchedKey?: string;
}

export interface TaskRelationSplitCanonicalResult {
  operationId?: string;
  outputHash?: string;
  adjudication?: TaskRelationCanonicalShadowAdjudication;
  unavailableReason?: string;
  clientError?: boolean;
}

export interface OrderedRelationOperationDependencies {
  now(): number;
  recordMetadata(traceId: string, metadata: Record<string, unknown>): void;
}

/** Consumes an already scheduled source-owned operation; it creates no task or request owner. */
export async function resolveOrderedTaskRelationWithinWindow(input: {
  handle: TaskRelationAdjudicationScheduleHandle;
  traceId: string;
  currentQuestionType: CanonicalQuestionType;
  currentQuestionTypeInherited?: boolean;
  allowParentRetype?: boolean;
  sourceKind: "voice" | "screen" | "mixed";
  activeMeetingTask?: ActiveMeetingTask;
  screenBoundaryPrior?: boolean;
  screenTypeEvidenceAuthorized?: boolean;
  waitBudgetMs: number;
  deadline?: OrderedSettlementDeadline;
}, dependencies: OrderedRelationOperationDependencies) {
  const startedAt = dependencies.now();
  const deadline =
    input.deadline ??
    createOrderedSettlementDeadline({
      startedAt: input.handle.affinityDeadlineAt === undefined
        ? startedAt
        : input.handle.affinityDeadlineAt - ORDERED_RELATION_STAGE_BUDGET_MS,
      budgetMs: input.waitBudgetMs,
    });
  const phaseBudget = createOrderedRelationPhaseBudget(deadline);
  if (input.handle.affinityDeadlineAt !== undefined) {
    phaseBudget.affinityCutoffAt = Math.min(phaseBudget.affinityCutoffAt, input.handle.affinityDeadlineAt);
  }
  let canonicalOutcome: TaskRelationSplitCanonicalResult | undefined;
  let canonicalDeadline: OrderedSettlementDeadline | undefined;
  let waitDisposition = input.handle.affinityOutcome
    ? "affinity-settled"
    : "affinity-unavailable";
  const readRemainingBudget = () =>
    readOrderedSettlementRemainingMs(canonicalDeadline ?? deadline, dependencies.now());
  // Each stage has one deadline arbiter: its owner settles the stage terminal
  // once. This consumer waits for that terminal and uses its value. It does not
  // time the stage itself, and a still-pending published snapshot is not the end
  // of the stage. A handle without a terminal is read synchronously.
  const settledAffinity = input.handle.affinityOutcome
    ? await input.handle.affinityOutcome
    : input.handle.readAffinityOutcome?.() ?? {
        child: { unavailableReason: "affinity-unavailable" },
        parent: { unavailableReason: "affinity-unavailable" },
      };
  // A selected candidate keeps its own completion time, so work that finished
  // by the cutoff is used; identity and lease are checked again at consumption.
  const timelyAffinity = filterTaskRelationAffinityOutcomeAtCutoff(
    settledAffinity,
    phaseBudget.affinityCutoffAt
  );
  let affinityOutcome =
    input.handle.revalidateAffinityOutcome?.(timelyAffinity) ?? timelyAffinity;
  let decision = decideOrderedTaskRelationResolution({
    sourceKind: input.sourceKind,
    currentQuestionType: input.currentQuestionType,
    allowParentRetype: input.allowParentRetype,
    currentQuestionTypeInherited: input.currentQuestionTypeInherited ??
      (input.sourceKind === "screen" && input.screenTypeEvidenceAuthorized === false),
    activeParentQuestionType:
      input.activeMeetingTask?.parent.questionType,
    activeChildQuestionType:
      input.activeMeetingTask?.child?.questionType,
    hasActiveChild: Boolean(input.activeMeetingTask?.child),
    childAffinity: affinityOutcome?.child.adjudication,
    parentAffinity: affinityOutcome?.parent.adjudication,
    screenBoundaryPrior: input.screenBoundaryPrior,
    screenTypeEvidenceAuthorized:
      input.screenTypeEvidenceAuthorized,
  });
  const affinityClientError = Boolean(affinityOutcome?.child.clientError || affinityOutcome?.parent.clientError);
  if (decision.status === "unresolved" && !affinityClientError) {
    canonicalDeadline = createOrderedRelationCanonicalDeadline(deadline, dependencies.now());
    // The same release gate follows the active phase, including event-loop drift.
    deadline.deadlineAt = canonicalDeadline.deadlineAt;
    deadline.budgetMs = deadline.deadlineAt - deadline.startedAt;
  }
  const canonicalPromise =
    decision.status === "unresolved" && !affinityClientError && readRemainingBudget() > 0
      ? input.handle.startCanonical?.({
          foreground: true,
          affinityOutcome,
          deadlineAt: canonicalDeadline?.deadlineAt,
        })
      : undefined;
  if (decision.status === "unresolved" && !canonicalPromise) {
    waitDisposition = "canonical-skipped-no-budget";
  }
  if (canonicalPromise) {
    // Canonical's own selector ends this stage at the deadline passed above.
    canonicalOutcome = await canonicalPromise;
    waitDisposition = canonicalOutcome.adjudication
      ? "canonical-settled"
      : "canonical-unresolved";
    decision = decideOrderedTaskRelationResolution({
      sourceKind: input.sourceKind,
      currentQuestionType: input.currentQuestionType,
      allowParentRetype: input.allowParentRetype,
      currentQuestionTypeInherited: input.currentQuestionTypeInherited ??
        (input.sourceKind === "screen" && input.screenTypeEvidenceAuthorized === false),
      activeParentQuestionType:
        input.activeMeetingTask?.parent.questionType,
      activeChildQuestionType:
        input.activeMeetingTask?.child?.questionType,
      hasActiveChild: Boolean(input.activeMeetingTask?.child),
      childAffinity: affinityOutcome?.child.adjudication,
      parentAffinity: affinityOutcome?.parent.adjudication,
      canonical: canonicalOutcome?.adjudication,
      screenBoundaryPrior: input.screenBoundaryPrior,
      screenTypeEvidenceAuthorized:
        input.screenTypeEvidenceAuthorized,
    });
  }
  if (decision.status === "unresolved") {
    affinityOutcome =
      input.handle.revalidateAffinityOutcome?.(affinityOutcome) ?? affinityOutcome;
    decision = decideOrderedTaskRelationResolution({
      sourceKind: input.sourceKind,
      currentQuestionType: input.currentQuestionType,
      allowParentRetype: input.allowParentRetype,
      currentQuestionTypeInherited: input.currentQuestionTypeInherited ??
        (input.sourceKind === "screen" && input.screenTypeEvidenceAuthorized === false),
      activeParentQuestionType:
        input.activeMeetingTask?.parent.questionType,
      activeChildQuestionType:
        input.activeMeetingTask?.child?.questionType,
      hasActiveChild: Boolean(input.activeMeetingTask?.child),
      childAffinity: affinityOutcome?.child.adjudication,
      parentAffinity: affinityOutcome?.parent.adjudication,
      canonical: canonicalOutcome?.adjudication,
      screenBoundaryPrior: input.screenBoundaryPrior,
      screenTypeEvidenceAuthorized:
        input.screenTypeEvidenceAuthorized,
      finalizeWithNullHypothesis: true,
    });
  }
  const foregroundClosed = readRemainingBudget() === 0;
  if (foregroundClosed) {
    input.handle.cancelForegroundWork?.();
  }
  const operationAuthorization = input.handle.authorizeOperation();
  const clientError = Boolean(
    affinityOutcome?.child.clientError ||
      affinityOutcome?.parent.clientError ||
      canonicalOutcome?.clientError
  );
  const metadata = {
    ...formatOrderedTaskRelationResolutionForTrace(decision),
    taskRelationOrderedResolutionWaitBudgetMs: deadline.budgetMs,
    taskRelationOrderedResolutionDeadlineAt: deadline.deadlineAt,
    taskRelationOrderedResolutionAffinityCutoffAt:
      phaseBudget.affinityCutoffAt,
    taskRelationOrderedResolutionCanonicalBudgetMs:
      phaseBudget.canonicalBudgetMs,
    taskRelationOrderedResolutionCanonicalDeadlineAt: canonicalDeadline?.deadlineAt,
    orderedSettlementForegroundDeadlineAt: deadline.deadlineAt,
    orderedSettlementForegroundBudgetMs: deadline.budgetMs,
    taskRelationOrderedResolutionRemainingMs:
      readOrderedSettlementRemainingMs(deadline, dependencies.now()),
    taskRelationOrderedResolutionSourceKind: input.sourceKind,
    taskRelationOrderedResolutionWaitMs: Math.max(
      0,
      dependencies.now() - startedAt
    ),
    taskRelationOrderedResolutionWaitDisposition: waitDisposition,
    taskRelationOrderedResolutionAffinityChildDisposition:
      affinityOutcome?.child.adjudication
        ? "available"
        : affinityOutcome?.child.unavailableReason,
    taskRelationOrderedResolutionAffinityParentDisposition:
      affinityOutcome?.parent.adjudication
        ? "available"
        : affinityOutcome?.parent.unavailableReason,
    taskRelationOrderedResolutionCanonicalDisposition:
      canonicalOutcome?.adjudication
        ? "available"
        : canonicalOutcome?.unavailableReason,
    taskRelationOrderedResolutionClientError: clientError,
    taskRelationOrderedResolutionLateWorkCancelled:
      foregroundClosed,
    taskRelationOrderedResolutionOperationAuthorized:
      operationAuthorization.authorized,
    taskRelationOrderedResolutionOperationReason:
      operationAuthorization.reason,
    taskRelationOrderedResolutionOperationMismatchedKey:
      operationAuthorization.mismatchedKey,
    taskRelationOrderedResolutionOperationCancelled:
      !operationAuthorization.authorized,
  };
  dependencies.recordMetadata(input.traceId, metadata);
  const terminalDisposition =
    resolveOrderedRelationOperationTerminal({
      operationAuthorized: operationAuthorization.authorized,
      clientError,
    });
  if (terminalDisposition !== "resolved") {
    input.handle.cancelForegroundWork?.();
  }
  return {
    terminalDisposition,
    decision,
    affinityOutcome,
    canonicalOutcome,
    operationAuthorization,
    metadata,
  };
}
