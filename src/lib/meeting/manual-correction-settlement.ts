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
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

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
    | "candidate-confidence-below-threshold"
    | "operation-lease-not-authorized";
  releasedRelation?: Exclude<
    LlmTaskRelationAdjudication["relation"],
    "unknown"
  >;
}

export function settleManualQuestionTypeCorrection(input: {
  operationId: string;
  currentQuestion: ProvisionalCurrentQuestion;
  correctedType: CanonicalQuestionType;
  activeParentId?: string;
  activeParentRevision?: number;
  manualCorrectionRevision: number;
  relationCandidate?: LlmTaskRelationAdjudication;
  relationOperationLeaseAuthorized?: boolean;
  forceNewParentFromSourceIdentity?: boolean;
  preserveActiveChildFromSourceIdentity?: boolean;
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
    input.forceNewParentFromSourceIdentity &&
    isParentCanonicalQuestionType(input.correctedType)
      ? "new-parent"
      : input.preserveActiveChildFromSourceIdentity &&
          input.correctedType !== "unknown"
        ? "child-probe"
        : undefined;
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
          deterministicRelation === "child-probe"
            ? "manual-correction-preserves-source-owned-child"
            : input.activeParentId
              ? "manual-correction-reseeds-parent-origin"
              : "manual-correction-creates-first-parent",
        ],
      } satisfies CurrentQuestionSettlementProposal)
    : undefined;
  const relationRelease = input.activeParentId
    ? authorizeOrderedManualCorrectionRelation({
        candidate: input.relationCandidate,
        operationLeaseAuthorized:
          input.relationOperationLeaseAuthorized === true,
      })
    : undefined;
  const llmRelationProposal =
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
        llmRelationRepairMinConfidence: 0.95,
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
  if (input.candidate.confidence < 0.95) {
    return {
      authorized: false,
      reason: "candidate-confidence-below-threshold",
    };
  }
  return {
    authorized: true,
    reason: "ordered-relation-authorized",
    releasedRelation: input.candidate.relation,
  };
}
