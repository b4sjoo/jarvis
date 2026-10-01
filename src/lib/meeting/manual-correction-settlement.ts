import {
  settleCurrentQuestion,
  type CurrentQuestionSettlementDecision,
  type CurrentQuestionSettlementProposal,
  type ProvisionalCurrentQuestion,
} from "./current-question-settlement.js";
import {
  createTaskRelationSettlementProposal,
  type LlmTaskRelationAdjudication,
} from "./task-relation-adjudication.js";
import {
  isParentCanonicalQuestionType,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";
import { authorizeManualCorrectionIntent, type ManualCorrectionCapability, type ManualCorrectionCapabilityContext, type ManualCorrectionIntent } from "./manual-correction-intent.js";

export function settleManualCorrectionIntent(input: {
  operationId: string;
  context: ManualCorrectionCapabilityContext;
  correctedType: CanonicalQuestionType;
  intent: ManualCorrectionIntent;
}) {
  const authorization = authorizeManualCorrectionIntent(input.context, input.correctedType, input.intent);
  if (!authorization.authorized) return authorization;
  const { currentQuestion, runtime, manualCorrectionRevision } = input.context;
  const capability = authorization.capability;
  const settlement = settleCurrentQuestion({
    operationId: input.operationId,
    currentQuestion,
    activeParentId: runtime.parent?.id,
    activeParentRevision: runtime.parent?.revisions,
    manualCorrectionRevision,
    manualProposal: {
      source: "manual-correction",
      sessionId: currentQuestion.sessionId,
      runtimeEpoch: currentQuestion.runtimeEpoch,
      logicalQuestionUnitId: currentQuestion.logicalQuestionUnitId,
      revision: currentQuestion.revision,
      sourceHash: currentQuestion.sourceHash,
      questionType: input.correctedType,
      relation: capability.relation,
      action: "answer",
      confidence: 1,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: true,
      actionEvidenceAuthorized: true,
      expectedParentId: runtime.parent?.id,
      expectedParentRevision: runtime.parent?.revisions,
      manualCorrectionRevision,
      reasons: ["explicit-manual-question-type-correction", `explicit-manual-intent:${input.intent.kind}`],
    },
    policy: {
      runtimeMutationAuthorized: true, questionComplete: true, commitParent: true,
      allowRuntimeTypeAdjudication: false, allowLlmRelationRepair: false, allowLlmActionRepair: false,
    },
  });
  return {
    authorized: true as const,
    capability,
    settlement: capability.intent.kind === "retype-parent"
      ? authorizeManualCorrectionLifecycle({ settlement, parentAction: capability.action,
          activeParentId: runtime.parent?.id, activeParentType: runtime.parent?.stableKind })
      : settlement,
  };
}

export interface ManualQuestionTypeCorrectionSettlementResult {
  settlement: CurrentQuestionSettlementDecision;
  relationRelease?: ManualCorrectionRelationAdmissionDecision;
}

export interface ManualCorrectionRelationAdmissionDecision {
  authorized: boolean;
  reason:
    | "ordered-relation-authorized"
    | "candidate-missing"
    | "candidate-relation-unknown"
    | "operation-lease-not-authorized";
  releasedRelation?: Exclude<
    LlmTaskRelationAdjudication["relation"],
    "unknown"
  >;
}

export function authorizeManualCorrectionLifecycle(input: {
  settlement: CurrentQuestionSettlementDecision;
  parentAction: ManualCorrectionCapability["action"];
  activeParentId?: string;
  activeParentType?: unknown;
}): CurrentQuestionSettlementDecision {
  const correctedType = normalizeCanonicalQuestionType(
    input.settlement.questionType
  );
  const activeParentType = normalizeCanonicalQuestionType(
    input.activeParentType
  );
  const relationSupportsCorrectionRetype =
    input.settlement.relation === "new-parent" ||
    input.settlement.relation === "followup-parent" ||
    input.settlement.relation === "resume-parent";
  if (
    input.parentAction !== "retype" ||
    !relationSupportsCorrectionRetype ||
    !input.activeParentId ||
    input.settlement.activeParentId !== input.activeParentId ||
    !correctedType ||
    !isParentCanonicalQuestionType(correctedType) ||
    !activeParentType ||
    correctedType === activeParentType
  ) {
    return input.settlement;
  }
  return Object.freeze({
    ...input.settlement,
    parentMutationAuthorized: true,
    reasons: Array.from(
      new Set([
        ...input.settlement.reasons.filter(
          (reason) => reason !== "relation-does-not-create-parent"
        ),
        "parent-mutation-authorized",
        "manual-correction-same-question-retype-authorized",
      ])
    ),
  });
}

export function settleManualQuestionTypeCorrection(input: {
  operationId: string;
  currentQuestion: ProvisionalCurrentQuestion;
  correctedType: CanonicalQuestionType;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
  relationCandidate?: LlmTaskRelationAdjudication;
  orderedRelationProposal?: CurrentQuestionSettlementProposal;
  relationOperationLeaseAuthorized?: boolean;
  revisionStableRelation?: Extract<
    CurrentQuestionSettlementDecision["relation"],
    "new-parent" | "followup-parent" | "child-probe" | "resume-parent"
  >;
  revisionStableRelationReason?: string;
}): ManualQuestionTypeCorrectionSettlementResult {
  const manualProposal: CurrentQuestionSettlementProposal = {
    source: "manual-correction",
    sessionId: input.currentQuestion.sessionId,
    runtimeEpoch: input.currentQuestion.runtimeEpoch,
    logicalQuestionUnitId: input.currentQuestion.logicalQuestionUnitId,
    revision: input.currentQuestion.revision,
    sourceHash: input.currentQuestion.sourceHash,
    questionType: input.correctedType,
    action: "answer",
    confidence: 1,
    typeEvidenceAuthorized: input.correctedType !== "unknown",
    relationEvidenceAuthorized: false,
    actionEvidenceAuthorized: true,
    manualCorrectionRevision: input.manualCorrectionRevision,
    expectedParentId: input.activeParentId,
    expectedParentRevision: input.activeParentRevision,
    reasons: [
      "explicit-manual-question-type-correction",
      "relation-authority-withheld-from-type-control",
    ],
  };
  const deterministicRelation =
    // A newly admitted child correction changes ownership. Historical mainline
    // binding only protects revisions which preserve that ownership.
    input.relationOperationLeaseAuthorized &&
    (input.relationCandidate?.relation === "child-probe" ||
      input.orderedRelationProposal?.relation === "child-probe" && input.orderedRelationProposal.relationEvidenceAuthorized === true) &&
    input.revisionStableRelation !== "child-probe"
      ? undefined
      : input.revisionStableRelation === "new-parent" &&
    !isParentCanonicalQuestionType(input.correctedType)
      ? undefined
      : input.correctedType === "unknown"
        ? undefined
        : input.revisionStableRelation;
  const deterministicRelationProposal = deterministicRelation
    ? ({
        source: "deterministic-fast-path",
        sessionId: input.currentQuestion.sessionId,
        runtimeEpoch: input.currentQuestion.runtimeEpoch,
        logicalQuestionUnitId:
          input.currentQuestion.logicalQuestionUnitId,
        revision: input.currentQuestion.revision,
        sourceHash: input.currentQuestion.sourceHash,
        relation: deterministicRelation,
        action: "answer",
        confidence: 1,
        typeEvidenceAuthorized: false,
        relationEvidenceAuthorized: true,
        actionEvidenceAuthorized: true,
        expectedParentId: input.activeParentId,
        expectedParentRevision: input.activeParentRevision,
        reasons: [
          input.revisionStableRelationReason ??
            "manual-correction-preserves-revision-stable-relation",
        ],
      } satisfies CurrentQuestionSettlementProposal)
    : input.orderedRelationProposal?.source === "deterministic-fast-path"
      ? input.orderedRelationProposal : undefined;
  const relationRelease = input.activeParentId
    ? authorizeOrderedManualCorrectionRelation({
        candidate: input.relationCandidate,
        operationLeaseAuthorized:
          input.relationOperationLeaseAuthorized === true,
      })
    : undefined;
  const llmRelationProposal = input.relationOperationLeaseAuthorized &&
    input.orderedRelationProposal?.source === "runtime-adjudication"
    ? input.orderedRelationProposal :
    relationRelease?.authorized &&
    input.relationCandidate &&
    input.activeParentId
      ? createTaskRelationSettlementProposal({
          currentQuestion: input.currentQuestion,
          adjudication: input.relationCandidate,
          expectedParentId: input.activeParentId,
          expectedParentRevision: input.activeParentRevision,
        })
      : undefined;

  return {
    relationRelease,
    settlement: settleCurrentQuestion({
      operationId: input.operationId,
      currentQuestion: input.currentQuestion,
      manualProposal,
      deterministicProposal: deterministicRelationProposal,
      llmProposal: llmRelationProposal,
      activeParentId: input.activeParentId,
      activeParentRevision: input.activeParentRevision,
      manualCorrectionRevision: input.manualCorrectionRevision,
      policy: {
        allowRuntimeTypeAdjudication: false,
        allowLlmRelationRepair: true,
        allowLlmActionRepair: false,
        llmRelationRepairMinConfidence: 0,
        runtimeMutationAuthorized: true,
        questionComplete: true,
        commitParent: true,
      },
    }),
  };
}

function authorizeOrderedManualCorrectionRelation(input: {
  candidate?: LlmTaskRelationAdjudication;
  operationLeaseAuthorized: boolean;
}): ManualCorrectionRelationAdmissionDecision {
  if (!input.operationLeaseAuthorized) {
    return {
      authorized: false,
      reason: "operation-lease-not-authorized",
    };
  }
  if (!input.candidate) {
    return { authorized: false, reason: "candidate-missing" };
  }
  if (input.candidate.relation === "unknown") {
    return {
      authorized: false,
      reason: "candidate-relation-unknown",
    };
  }
  return {
    authorized: true,
    reason: "ordered-relation-authorized",
    releasedRelation: input.candidate.relation,
  };
}
