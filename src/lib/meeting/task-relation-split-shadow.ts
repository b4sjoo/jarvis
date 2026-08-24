import {
  buildRuntimeInferenceModelInput,
  hashRuntimeSemanticPayload,
  type RuntimeInferenceOperationKind,
} from "./runtime-inference.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";
import type {
  RuntimeTaskRelation,
  TaskRelationAdjudicationRequest,
  TaskRelationSourceEvidenceRole,
} from "./task-relation-adjudication.js";
import {
  areCompatibleParentContinuityTypes,
  canParentQuestionTypeOwnChild,
  canQuestionTypeCreateParent,
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export const TASK_RELATION_AFFINITY_SCHEMA_VERSION = 1;
export const TASK_RELATION_CANONICAL_SHADOW_SCHEMA_VERSION = 3;
export const TASK_RELATION_SPLIT_MAX_OUTPUT_CHARS = 2_048;
export const FIRST_BATCH_RELATION_RELEASE_MIN_CONFIDENCE = 0.95;
export const FIRST_BATCH_RELATION_POSSIBLE_ERROR_MIN_CONFIDENCE = 0.9;
export const TASK_RELATION_CHILD_AFFINITY_PROMPT_VERSION =
  "task-relation-child-affinity-v1";
export const TASK_RELATION_PARENT_AFFINITY_PROMPT_VERSION =
  "task-relation-parent-affinity-v1";
export const TASK_RELATION_CANONICAL_SHADOW_PROMPT_VERSION =
  "task-relation-canonical-shadow-v1";

export type TaskRelationAffinityKind = "child" | "parent";
export type ChildAffinityDecision = "related" | "unrelated" | "unclear";
export type ParentAffinityDecision = "related" | "independent" | "unclear";

export interface TaskRelationSplitIdentity {
  sessionId: string;
  runtimeEpoch: number;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  sourceSettlementId: string;
  sourceHash: string;
  parentId: string;
  parentRevision: number;
  childId?: string;
  manualCorrectionRevision: number;
}

export interface TaskRelationRecentSemanticEvidence {
  index: number;
  text: string;
  role?: TaskRelationSourceEvidenceRole;
}

export interface ChildAffinitySemanticPayload {
  currentQuestion: { sourceTexts: string[] };
  activeChild: {
    question: string;
    sourceEvidence: string[];
  };
  recentBranchEvidence: TaskRelationRecentSemanticEvidence[];
}

export interface ParentAffinitySemanticPayload {
  currentQuestion: { sourceTexts: string[] };
  activeParent: {
    topic: string;
    objective: string;
    acceptedConstraints: string[];
    sourceEvidence: string[];
  };
  recentParentEvidence: TaskRelationRecentSemanticEvidence[];
}

export interface TaskRelationAffinityRequest<
  TKind extends TaskRelationAffinityKind = TaskRelationAffinityKind,
> {
  operationKind: TKind extends "child"
    ? "task-relation-child-affinity"
    : "task-relation-parent-affinity";
  affinityKind: TKind;
  promptVersion: string;
  schemaVersion: 1;
  identity: TaskRelationSplitIdentity;
  semanticPayload: TKind extends "child"
    ? ChildAffinitySemanticPayload
    : ParentAffinitySemanticPayload;
  semanticPayloadDigest: string;
}

export interface TaskRelationAffinityAdjudication {
  schemaVersion: 1;
  affinityKind: TaskRelationAffinityKind;
  decision: ChildAffinityDecision | ParentAffinityDecision;
  confidence: number;
  currentEvidenceSpans: string[];
  branchEvidenceSpans: string[];
  ambiguityReason?: string;
}

export type TaskRelationAffinityParseResult =
  | {
      ok: true;
      value: TaskRelationAffinityAdjudication;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: false;
    };

export type ChildAffinitySemanticResult =
  | {
      status: "available";
      decision: ChildAffinityDecision;
      confidence: number;
      currentEvidenceSpans: string[];
      childEvidenceSpans: string[];
    }
  | { status: "unavailable" };

export type ParentAffinitySemanticResult =
  | {
      status: "available";
      decision: ParentAffinityDecision;
      confidence: number;
      currentEvidenceSpans: string[];
      parentEvidenceSpans: string[];
    }
  | { status: "unavailable" };

export interface CanonicalRelationSemanticPayload {
  currentQuestion: { sourceTexts: string[] };
  activeParent: {
    topic: string;
    objective: string;
    acceptedConstraints: string[];
  };
  activeChild?: { question: string };
  recentEvidence: TaskRelationRecentSemanticEvidence[];
  affinity: {
    child: ChildAffinitySemanticResult;
    parent: ParentAffinitySemanticResult;
  };
}

export interface TaskRelationCanonicalShadowRequest {
  operationKind: "task-relation-canonical-shadow";
  promptVersion: string;
  schemaVersion: 3;
  identity: TaskRelationSplitIdentity;
  semanticPayload: CanonicalRelationSemanticPayload;
  semanticPayloadDigest: string;
  childPredecessorOperationId?: string;
  childPredecessorOutputHash?: string;
  parentPredecessorOperationId?: string;
  parentPredecessorOutputHash?: string;
}

export interface TaskRelationCanonicalShadowAdjudication {
  schemaVersion: 3;
  relation: RuntimeTaskRelation;
  confidence: number;
  currentQuestionEvidenceSpans: string[];
  parentEvidenceSpans: string[];
  ambiguityReason?: string;
}

export type FirstBatchRelationReleaseReason =
  | "no-parent-parent-eligible"
  | "no-parent-response-only"
  | "same-type-parent-related"
  | "allowed-child-parent-related"
  | "different-parent-type-independent"
  | "nonparent-type-independent-response-only"
  | "active-child-resume-parent"
  | "affinity-missing"
  | "affinity-unclear"
  | "affinity-below-release-threshold"
  | "same-type-independent-shadow"
  | "parent-related-type-incompatible"
  | "active-child-combination-not-released";

export interface FirstBatchRelationReleaseDecision {
  authorized: boolean;
  relation?: Exclude<RuntimeTaskRelation, "unknown">;
  responseOnly: boolean;
  reason: FirstBatchRelationReleaseReason;
  confidence: number;
  minimumConfidence: number;
  possibleRelationError: boolean;
  currentQuestionType: CanonicalQuestionType;
  activeParentQuestionType?: CanonicalQuestionType;
  childAffinityDecision?: ChildAffinityDecision;
  childAffinityConfidence?: number;
  parentAffinityDecision?: ParentAffinityDecision;
  parentAffinityConfidence?: number;
}

export function decideFirstBatchRelationRelease(input: {
  currentQuestionType: unknown;
  activeParentQuestionType?: unknown;
  hasActiveChild: boolean;
  childAffinity?: TaskRelationAffinityAdjudication;
  parentAffinity?: TaskRelationAffinityAdjudication;
}): FirstBatchRelationReleaseDecision {
  const currentQuestionType =
    normalizeCanonicalQuestionType(input.currentQuestionType) ?? "unknown";
  const activeParentQuestionType = normalizeCanonicalQuestionType(
    input.activeParentQuestionType
  );
  const childAffinity =
    input.childAffinity?.affinityKind === "child"
      ? input.childAffinity
      : undefined;
  const parentAffinity =
    input.parentAffinity?.affinityKind === "parent"
      ? input.parentAffinity
      : undefined;
  const base = {
    currentQuestionType,
    activeParentQuestionType,
    childAffinityDecision: childAffinity?.decision as
      | ChildAffinityDecision
      | undefined,
    childAffinityConfidence: childAffinity?.confidence,
    parentAffinityDecision: parentAffinity?.decision as
      | ParentAffinityDecision
      | undefined,
    parentAffinityConfidence: parentAffinity?.confidence,
    minimumConfidence: FIRST_BATCH_RELATION_RELEASE_MIN_CONFIDENCE,
  };
  const decide = (
    decision: Omit<
      FirstBatchRelationReleaseDecision,
      keyof typeof base
    >
  ): FirstBatchRelationReleaseDecision => ({ ...base, ...decision });

  if (!activeParentQuestionType) {
    return canQuestionTypeCreateParent(currentQuestionType)
      ? decide({
          authorized: true,
          relation: "new-parent",
          responseOnly: false,
          reason: "no-parent-parent-eligible",
          confidence: 1,
          possibleRelationError: false,
        })
      : decide({
          authorized: false,
          responseOnly: true,
          reason: "no-parent-response-only",
          confidence: 1,
          possibleRelationError: false,
        });
  }

  if (!parentAffinity) {
    return decide({
      authorized: false,
      responseOnly: false,
      reason: "affinity-missing",
      confidence: 0,
      possibleRelationError: false,
    });
  }
  const parentConfidence = parentAffinity.confidence;
  const childConfidence = childAffinity?.confidence ?? 1;
  const confidence = Math.min(parentConfidence, childConfidence);
  const possibleRelationError =
    confidence >= FIRST_BATCH_RELATION_POSSIBLE_ERROR_MIN_CONFIDENCE &&
    confidence < FIRST_BATCH_RELATION_RELEASE_MIN_CONFIDENCE;
  if (
    parentAffinity.decision === "unclear" ||
    childAffinity?.decision === "unclear"
  ) {
    return decide({
      authorized: false,
      responseOnly: false,
      reason: "affinity-unclear",
      confidence,
      possibleRelationError,
    });
  }
  if (confidence < FIRST_BATCH_RELATION_RELEASE_MIN_CONFIDENCE) {
    return decide({
      authorized: false,
      responseOnly: false,
      reason: "affinity-below-release-threshold",
      confidence,
      possibleRelationError,
    });
  }

  if (input.hasActiveChild) {
    if (
      childAffinity?.decision === "unrelated" &&
      parentAffinity.decision === "related" &&
      areCompatibleParentContinuityTypes(
        currentQuestionType,
        activeParentQuestionType
      )
    ) {
      return decide({
        authorized: true,
        relation: "resume-parent",
        responseOnly: false,
        reason: "active-child-resume-parent",
        confidence,
        possibleRelationError: false,
      });
    }
    return decide({
      authorized: false,
      responseOnly: false,
      reason: "active-child-combination-not-released",
      confidence,
      possibleRelationError: false,
    });
  }

  if (parentAffinity.decision === "related") {
    if (currentQuestionType === activeParentQuestionType) {
      return decide({
        authorized: true,
        relation: "followup-parent",
        responseOnly: false,
        reason: "same-type-parent-related",
        confidence,
        possibleRelationError: false,
      });
    }
    if (
      canParentQuestionTypeOwnChild(
        activeParentQuestionType,
        currentQuestionType
      )
    ) {
      return decide({
        authorized: true,
        relation: "child-probe",
        responseOnly: false,
        reason: "allowed-child-parent-related",
        confidence,
        possibleRelationError: false,
      });
    }
    return decide({
      authorized: false,
      responseOnly: false,
      reason: "parent-related-type-incompatible",
      confidence,
      possibleRelationError: false,
    });
  }

  if (currentQuestionType === activeParentQuestionType) {
    return decide({
      authorized: false,
      responseOnly: false,
      reason: "same-type-independent-shadow",
      confidence,
      possibleRelationError: false,
    });
  }
  if (canQuestionTypeCreateParent(currentQuestionType)) {
    return decide({
      authorized: true,
      relation: "new-parent",
      responseOnly: false,
      reason: "different-parent-type-independent",
      confidence,
      possibleRelationError: false,
    });
  }
  return decide({
    authorized: false,
    responseOnly: true,
    reason: "nonparent-type-independent-response-only",
    confidence,
    possibleRelationError: false,
  });
}

export function formatFirstBatchRelationReleaseForTrace(
  decision: FirstBatchRelationReleaseDecision | undefined
) {
  if (!decision) return {};
  return {
    taskRelationFirstBatchReleaseAuthorized: decision.authorized,
    taskRelationFirstBatchReleasedRelation: decision.relation,
    taskRelationFirstBatchResponseOnly: decision.responseOnly,
    taskRelationFirstBatchReleaseReason: decision.reason,
    taskRelationFirstBatchReleaseConfidence: decision.confidence,
    taskRelationFirstBatchReleaseMinimumConfidence:
      decision.minimumConfidence,
    taskRelationFirstBatchPossibleError:
      decision.possibleRelationError,
    taskRelationFirstBatchCurrentQuestionType:
      decision.currentQuestionType,
    taskRelationFirstBatchActiveParentQuestionType:
      decision.activeParentQuestionType,
    taskRelationFirstBatchChildAffinity:
      decision.childAffinityDecision,
    taskRelationFirstBatchChildAffinityConfidence:
      decision.childAffinityConfidence,
    taskRelationFirstBatchParentAffinity:
      decision.parentAffinityDecision,
    taskRelationFirstBatchParentAffinityConfidence:
      decision.parentAffinityConfidence,
  };
}

export type TaskRelationCanonicalShadowParseResult =
  | {
      ok: true;
      value: TaskRelationCanonicalShadowAdjudication;
      evidenceSpansValid: true;
    }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: false;
    };

export interface TaskRelationSplitLease {
  operationId: string;
  operationKind:
    | "task-relation-child-affinity"
    | "task-relation-parent-affinity"
    | "task-relation-canonical-shadow";
  identity: TaskRelationSplitIdentity;
  semanticPayloadDigest: string;
  createdAt: number;
}

export interface TaskRelationSplitShadowJob<
  TRequest extends
    | TaskRelationAffinityRequest
    | TaskRelationCanonicalShadowRequest,
> extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: TaskRelationSplitLease;
  request: TRequest;
}

export function buildTaskRelationAffinityRequests(input: {
  request: TaskRelationAdjudicationRequest;
  sessionId: string;
  runtimeEpoch: number;
  manualCorrectionRevision: number;
}) {
  const identity = buildSplitIdentity(
    input.request,
    input.manualCorrectionRevision,
    input.sessionId,
    input.runtimeEpoch
  );
  const currentQuestion = {
    sourceTexts: input.request.currentQuestion.sourceTurns.map(
      (source) => source.text
    ),
  };
  const parentPayload: ParentAffinitySemanticPayload = {
    currentQuestion,
    activeParent: {
      topic: input.request.activeParent.topic,
      objective: input.request.activeParent.compactObjective,
      acceptedConstraints:
        input.request.activeParent.acceptedConstraints.map(
          (item) => item.text
        ),
      sourceEvidence: [],
    },
    recentParentEvidence: toRecentSemanticEvidence(
      input.request.recentParentEvidence
    ),
  };
  const parent = buildAffinityRequest("parent", identity, parentPayload);
  const child = input.request.activeChild
    ? buildAffinityRequest("child", identity, {
        currentQuestion,
        activeChild: {
          question: input.request.activeChild.question,
          sourceEvidence: [],
        },
        recentBranchEvidence: toRecentSemanticEvidence(
          input.request.recentBranchEvidence
        ),
      })
    : undefined;
  return { child, parent };
}

export function buildTaskRelationAffinityPrompts(
  request: TaskRelationAffinityRequest
) {
  const child = request.affinityKind === "child";
  const systemPrompt = child
    ? [
        "Decide one thing only: whether the current interviewer question depends on and continues the supplied active child question.",
        "Return one JSON object only. Do not answer the interview question.",
        "Use related only when answering the current question requires the active child question or its source evidence.",
        "Use unrelated when the current question can be answered without the active child, returns to a broader parent, or starts another task.",
        "Use unclear when the bounded evidence cannot decide.",
        "Time proximity, shared vocabulary, and broad topic overlap are not enough.",
        "Do not decide final task relation, parent mutation, question type, response action, context scope, phase, memory, or artifacts.",
        "For related, return exactly one currentEvidenceSpans item and one childEvidenceSpans item copied verbatim from matching fields.",
        "For unrelated, return exactly one currentEvidenceSpans item and an empty childEvidenceSpans array.",
        "For unclear, return empty evidence arrays and one short ambiguityReason.",
        "Schema: {schemaVersion:1,decision:'related'|'unrelated'|'unclear',confidence:number,currentEvidenceSpans:string[],childEvidenceSpans:string[],ambiguityReason?:string}.",
      ].join(" ")
    : [
        "Decide one thing only: whether the current interviewer question depends on and continues the supplied active parent objective.",
        "Return one JSON object only. Do not answer the interview question.",
        "Use related only when answering the current question requires the active parent objective, accepted constraints, or source evidence.",
        "Use independent when the current question is a self-contained task that can be answered without the active parent.",
        "Use unclear when the bounded evidence cannot decide.",
        "Time proximity, compatible question type, shared vocabulary, and broad topic overlap are not enough.",
        "Do not decide child status, resume intent, final task relation, parent mutation, question type, response action, phase, memory, or artifacts.",
        "For related, return exactly one currentEvidenceSpans item and one parentEvidenceSpans item copied verbatim from matching fields.",
        "For independent, return exactly one currentEvidenceSpans item and an empty parentEvidenceSpans array.",
        "For unclear, return empty evidence arrays and one short ambiguityReason.",
        "Schema: {schemaVersion:1,decision:'related'|'independent'|'unclear',confidence:number,currentEvidenceSpans:string[],parentEvidenceSpans:string[],ambiguityReason?:string}.",
      ].join(" ");
  return buildRuntimeInferenceModelInput({
    systemPrompt,
    semanticPayload: request.semanticPayload,
  });
}

export function parseTaskRelationAffinityOutput(
  rawOutput: string,
  request: TaskRelationAffinityRequest
): TaskRelationAffinityParseResult {
  const parsed = parseJsonObject(rawOutput);
  if (!parsed.ok) return parsed;
  const candidate = parsed.value;
  const branchKey =
    request.affinityKind === "child"
      ? "childEvidenceSpans"
      : "parentEvidenceSpans";
  const allowedKeys = new Set([
    "schemaVersion",
    "decision",
    "confidence",
    "currentEvidenceSpans",
    branchKey,
    "ambiguityReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("unexpected-field", "schema");
  }
  const validDecision =
    request.affinityKind === "child"
      ? candidate.decision === "related" ||
        candidate.decision === "unrelated" ||
        candidate.decision === "unclear"
      : candidate.decision === "related" ||
        candidate.decision === "independent" ||
        candidate.decision === "unclear";
  if (
    candidate.schemaVersion !== TASK_RELATION_AFFINITY_SCHEMA_VERSION ||
    !validDecision ||
    !isConfidence(candidate.confidence) ||
    !isEvidenceArray(candidate.currentEvidenceSpans) ||
    !isEvidenceArray(candidate[branchKey])
  ) {
    return parseFailure("invalid-affinity-schema", "schema");
  }
  const currentEvidenceSpans = normalizeEvidenceArray(
    candidate.currentEvidenceSpans
  );
  const branchEvidenceSpans = normalizeEvidenceArray(candidate[branchKey]);
  const unclear = candidate.decision === "unclear";
  if (
    unclear !==
      (currentEvidenceSpans.length === 0 &&
        branchEvidenceSpans.length === 0 &&
        typeof candidate.ambiguityReason === "string" &&
        Boolean(candidate.ambiguityReason.trim()))
  ) {
    return parseFailure("invalid-unclear-contract", "evidence");
  }
  if (!unclear) {
    const related = candidate.decision === "related";
    if (
      currentEvidenceSpans.length !== 1 ||
      (related
        ? branchEvidenceSpans.length !== 1
        : branchEvidenceSpans.length !== 0)
    ) {
      return parseFailure("invalid-definite-evidence-shape", "evidence");
    }
  }
  const currentCorpus = currentQuestionCorpus(request.semanticPayload);
  const branchCorpus = affinityBranchCorpus(request);
  if (
    !allSpansGrounded(currentEvidenceSpans, currentCorpus) ||
    !allSpansGrounded(branchEvidenceSpans, branchCorpus)
  ) {
    return parseFailure("ungrounded-evidence", "evidence");
  }
  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: 1,
      affinityKind: request.affinityKind,
      decision: candidate.decision as
        | ChildAffinityDecision
        | ParentAffinityDecision,
      confidence: candidate.confidence as number,
      currentEvidenceSpans,
      branchEvidenceSpans,
      ambiguityReason:
        typeof candidate.ambiguityReason === "string"
          ? candidate.ambiguityReason.trim()
          : undefined,
    },
  };
}

export function buildTaskRelationCanonicalShadowRequest(input: {
  request: TaskRelationAdjudicationRequest;
  sessionId: string;
  runtimeEpoch: number;
  manualCorrectionRevision: number;
  child?: {
    operationId?: string;
    outputHash?: string;
    adjudication?: TaskRelationAffinityAdjudication;
    unavailableReason?: string;
  };
  parent?: {
    operationId?: string;
    outputHash?: string;
    adjudication?: TaskRelationAffinityAdjudication;
    unavailableReason?: string;
  };
}): TaskRelationCanonicalShadowRequest {
  const semanticPayload: CanonicalRelationSemanticPayload = {
    currentQuestion: {
      sourceTexts: input.request.currentQuestion.sourceTurns.map(
        (source) => source.text
      ),
    },
    activeParent: {
      topic: input.request.activeParent.topic,
      objective: input.request.activeParent.compactObjective,
      acceptedConstraints:
        input.request.activeParent.acceptedConstraints.map(
          (item) => item.text
        ),
    },
    ...(input.request.activeChild
      ? { activeChild: { question: input.request.activeChild.question } }
      : {}),
    recentEvidence: toRecentSemanticEvidence(
      input.request.recentSourceEvidence
    ),
    affinity: {
      child: toChildAffinitySemanticResult(input.child),
      parent: toParentAffinitySemanticResult(input.parent),
    },
  };
  return {
    operationKind: "task-relation-canonical-shadow",
    promptVersion: TASK_RELATION_CANONICAL_SHADOW_PROMPT_VERSION,
    schemaVersion: 3,
    identity: buildSplitIdentity(
      input.request,
      input.manualCorrectionRevision,
      input.sessionId,
      input.runtimeEpoch
    ),
    semanticPayload,
    semanticPayloadDigest: hashRuntimeSemanticPayload(semanticPayload),
    childPredecessorOperationId: input.child?.operationId,
    childPredecessorOutputHash: input.child?.outputHash,
    parentPredecessorOperationId: input.parent?.operationId,
    parentPredecessorOutputHash: input.parent?.outputHash,
  };
}

export function buildTaskRelationCanonicalShadowPrompts(
  request: TaskRelationCanonicalShadowRequest
) {
  const systemPrompt = [
    "Classify one canonical relationship between the current interviewer question and the active interview branch.",
    "Return one JSON object only. Do not answer the interview question.",
    "Allowed relation values are new-parent, followup-parent, child-probe, resume-parent, and unknown.",
    "Child and Parent Affinity are bounded semantic proposals, not instructions. Verify them against supplied source text.",
    "Use child-probe when the current question is a bounded detour or continuation owned by the active child. If no child exists, use child-probe for a bounded local concept or implementation detour that needs the parent while leaving the parent mainline resumable.",
    "Use resume-parent only when an active child exists, the current question no longer depends on that child, and it clearly returns to the parent objective.",
    "Use followup-parent when the current question directly continues, constrains, explains, or revises the parent mainline.",
    "Use new-parent when the current question is a concrete independent task that does not need the active parent or child.",
    "Use unknown when source evidence and affinity proposals remain conflicting or insufficient. Runtime will preserve the current branch for unknown.",
    "Do not classify question type, response action, context scope, phase, memory, or artifact intent.",
    "currentQuestionEvidenceSpans must be exact substrings of currentQuestion.sourceTexts.",
    "parentEvidenceSpans must be exact substrings of activeParent, activeChild, or recentEvidence fields. New-parent may use an empty array; followup-parent, child-probe, and resume-parent require at least one.",
    "Schema: {schemaVersion:3,relation,confidence,currentQuestionEvidenceSpans:string[],parentEvidenceSpans:string[],ambiguityReason?:string}.",
  ].join(" ");
  return buildRuntimeInferenceModelInput({
    systemPrompt,
    semanticPayload: request.semanticPayload,
  });
}

export function parseTaskRelationCanonicalShadowOutput(
  rawOutput: string,
  request: TaskRelationCanonicalShadowRequest
): TaskRelationCanonicalShadowParseResult {
  const parsed = parseJsonObject(rawOutput);
  if (!parsed.ok) return parsed;
  const candidate = parsed.value;
  const allowedKeys = new Set([
    "schemaVersion",
    "relation",
    "confidence",
    "currentQuestionEvidenceSpans",
    "parentEvidenceSpans",
    "ambiguityReason",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return parseFailure("unexpected-field", "schema");
  }
  if (
    candidate.schemaVersion !== 3 ||
    !isRuntimeRelation(candidate.relation) ||
    !isConfidence(candidate.confidence) ||
    !isEvidenceArray(candidate.currentQuestionEvidenceSpans) ||
    !isEvidenceArray(candidate.parentEvidenceSpans)
  ) {
    return parseFailure("invalid-canonical-schema", "schema");
  }
  const currentQuestionEvidenceSpans = normalizeEvidenceArray(
    candidate.currentQuestionEvidenceSpans
  );
  const parentEvidenceSpans = normalizeEvidenceArray(
    candidate.parentEvidenceSpans
  );
  if (!currentQuestionEvidenceSpans.length) {
    return parseFailure("current-evidence-required", "evidence");
  }
  if (
    candidate.relation !== "new-parent" &&
    candidate.relation !== "unknown" &&
    !parentEvidenceSpans.length
  ) {
    return parseFailure("parent-evidence-required", "evidence");
  }
  if (
    !allSpansGrounded(
      currentQuestionEvidenceSpans,
      currentQuestionCorpus(request.semanticPayload)
    ) ||
    !allSpansGrounded(
      parentEvidenceSpans,
      canonicalParentCorpus(request.semanticPayload)
    )
  ) {
    return parseFailure("ungrounded-evidence", "evidence");
  }
  return {
    ok: true,
    evidenceSpansValid: true,
    value: {
      schemaVersion: 3,
      relation: candidate.relation as RuntimeTaskRelation,
      confidence: candidate.confidence as number,
      currentQuestionEvidenceSpans,
      parentEvidenceSpans,
      ambiguityReason:
        typeof candidate.ambiguityReason === "string"
          ? candidate.ambiguityReason.trim()
          : undefined,
    },
  };
}

export function createTaskRelationSplitLease(input: {
  request:
    | TaskRelationAffinityRequest
    | TaskRelationCanonicalShadowRequest;
  createdAt?: number;
}): TaskRelationSplitLease {
  const request = input.request;
  return {
    operationId: [
      request.operationKind,
      request.identity.sessionId,
      request.identity.runtimeEpoch,
      request.identity.logicalQuestionUnitId,
      request.identity.logicalQuestionUnitRevision,
      request.identity.parentRevision,
      request.identity.childId ?? "no-child",
      request.identity.manualCorrectionRevision,
      request.semanticPayloadDigest,
    ].join(":"),
    operationKind: request.operationKind,
    identity: { ...request.identity },
    semanticPayloadDigest: request.semanticPayloadDigest,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function authorizeTaskRelationSplitLease(
  lease: TaskRelationSplitLease,
  current: {
    currentOperationId?: string;
    operationKind: TaskRelationSplitLease["operationKind"];
    identity: TaskRelationSplitIdentity;
    semanticPayloadDigest: string;
  }
) {
  const reject = (reason: string) => ({ authorized: false as const, reason });
  if (lease.operationId !== current.currentOperationId) {
    return reject("operation-id-mismatch");
  }
  if (lease.operationKind !== current.operationKind) {
    return reject("operation-kind-mismatch");
  }
  for (const key of [
    "sessionId",
    "runtimeEpoch",
    "logicalQuestionUnitId",
    "logicalQuestionUnitRevision",
    "sourceSettlementId",
    "sourceHash",
    "parentId",
    "parentRevision",
    "childId",
    "manualCorrectionRevision",
  ] as const) {
    if (lease.identity[key] !== current.identity[key]) {
      return reject(`${key}-mismatch`);
    }
  }
  if (lease.semanticPayloadDigest !== current.semanticPayloadDigest) {
    return reject("semantic-payload-mismatch");
  }
  return { authorized: true as const, reason: "authorized" };
}

export function authorizeTaskRelationCanonicalPredecessors(input: {
  request: TaskRelationCanonicalShadowRequest;
  currentChildOperationId?: string;
  currentChildOutputHash?: string;
  currentParentOperationId?: string;
  currentParentOutputHash?: string;
}) {
  const reject = (reason: string) => ({ authorized: false as const, reason });
  if (
    input.request.childPredecessorOperationId !==
    input.currentChildOperationId
  ) {
    return reject("child-predecessor-operation-mismatch");
  }
  if (
    input.request.childPredecessorOutputHash !==
    input.currentChildOutputHash
  ) {
    return reject("child-predecessor-output-mismatch");
  }
  if (
    input.request.parentPredecessorOperationId !==
    input.currentParentOperationId
  ) {
    return reject("parent-predecessor-operation-mismatch");
  }
  if (
    input.request.parentPredecessorOutputHash !==
    input.currentParentOutputHash
  ) {
    return reject("parent-predecessor-output-mismatch");
  }
  return { authorized: true as const, reason: "authorized" };
}

export function hashTaskRelationSplitOutput(value: unknown) {
  return hashRuntimeSemanticPayload(value);
}

export function createAblatedCanonicalRelationRequest(
  request: TaskRelationCanonicalShadowRequest
) {
  const semanticPayload: CanonicalRelationSemanticPayload = {
    ...request.semanticPayload,
    affinity: {
      child: { status: "unavailable" },
      parent: { status: "unavailable" },
    },
  };
  return {
    ...request,
    semanticPayload,
    semanticPayloadDigest: hashRuntimeSemanticPayload(semanticPayload),
  };
}

export function createShuffledCanonicalRelationRequest(
  request: TaskRelationCanonicalShadowRequest,
  affinity: CanonicalRelationSemanticPayload["affinity"]
) {
  const semanticPayload: CanonicalRelationSemanticPayload = {
    ...request.semanticPayload,
    affinity: JSON.parse(JSON.stringify(affinity)) as CanonicalRelationSemanticPayload["affinity"],
  };
  return {
    ...request,
    semanticPayload,
    semanticPayloadDigest: hashRuntimeSemanticPayload(semanticPayload),
  };
}

export function compareTaskRelationSplitShadow(input: {
  monolithicRelation?: RuntimeTaskRelation;
  canonicalRelation?: RuntimeTaskRelation;
  ablatedRelation?: RuntimeTaskRelation;
  shuffledRelation?: RuntimeTaskRelation;
}) {
  return {
    canonicalAvailable: Boolean(input.canonicalRelation),
    canonicalDelta:
      input.monolithicRelation && input.canonicalRelation
        ? input.monolithicRelation !== input.canonicalRelation
        : undefined,
    ablationDelta:
      input.canonicalRelation && input.ablatedRelation
        ? input.canonicalRelation !== input.ablatedRelation
        : undefined,
    shuffleSensitive:
      input.canonicalRelation && input.shuffledRelation
        ? input.canonicalRelation !== input.shuffledRelation
        : undefined,
  };
}

function buildAffinityRequest<TKind extends TaskRelationAffinityKind>(
  affinityKind: TKind,
  identity: TaskRelationSplitIdentity,
  semanticPayload: TKind extends "child"
    ? ChildAffinitySemanticPayload
    : ParentAffinitySemanticPayload
): TaskRelationAffinityRequest<TKind> {
  return {
    operationKind:
      affinityKind === "child"
        ? "task-relation-child-affinity"
        : "task-relation-parent-affinity",
    affinityKind,
    promptVersion:
      affinityKind === "child"
        ? TASK_RELATION_CHILD_AFFINITY_PROMPT_VERSION
        : TASK_RELATION_PARENT_AFFINITY_PROMPT_VERSION,
    schemaVersion: 1,
    identity: { ...identity },
    semanticPayload,
    semanticPayloadDigest: hashRuntimeSemanticPayload(semanticPayload),
  } as TaskRelationAffinityRequest<TKind>;
}

function buildSplitIdentity(
  request: TaskRelationAdjudicationRequest,
  manualCorrectionRevision: number,
  sessionId: string,
  runtimeEpoch: number
): TaskRelationSplitIdentity {
  return {
    sessionId,
    runtimeEpoch,
    logicalQuestionUnitId: request.logicalQuestionUnitId,
    logicalQuestionUnitRevision: request.logicalQuestionUnitRevision,
    sourceSettlementId: request.sourceSettlementId,
    sourceHash: request.sourceHash,
    parentId: request.activeParent.parentId,
    parentRevision: request.activeParent.revision,
    childId: request.activeChild?.childId,
    manualCorrectionRevision,
  };
}

function toRecentSemanticEvidence(
  evidence: TaskRelationAdjudicationRequest["recentSourceEvidence"]
) {
  return evidence.map((item, index) => ({
    index,
    text: item.text,
    ...(item.role ? { role: item.role } : {}),
  }));
}

function toChildAffinitySemanticResult(
  result:
    | {
        adjudication?: TaskRelationAffinityAdjudication;
        unavailableReason?: string;
      }
    | undefined,
): ChildAffinitySemanticResult {
  const adjudication = result?.adjudication;
  return adjudication && adjudication.affinityKind === "child"
    ? {
        status: "available",
        decision: adjudication.decision as ChildAffinityDecision,
        confidence: adjudication.confidence,
        currentEvidenceSpans: [...adjudication.currentEvidenceSpans],
        childEvidenceSpans: [...adjudication.branchEvidenceSpans],
      }
    : { status: "unavailable" };
}

function toParentAffinitySemanticResult(
  result:
    | {
        adjudication?: TaskRelationAffinityAdjudication;
        unavailableReason?: string;
      }
    | undefined
): ParentAffinitySemanticResult {
  const adjudication = result?.adjudication;
  return adjudication && adjudication.affinityKind === "parent"
    ? {
        status: "available",
        decision: adjudication.decision as ParentAffinityDecision,
        confidence: adjudication.confidence,
        currentEvidenceSpans: [...adjudication.currentEvidenceSpans],
        parentEvidenceSpans: [...adjudication.branchEvidenceSpans],
      }
    : { status: "unavailable" };
}

function currentQuestionCorpus(
  payload:
    | ChildAffinitySemanticPayload
    | ParentAffinitySemanticPayload
    | CanonicalRelationSemanticPayload
) {
  return payload.currentQuestion.sourceTexts.join("\n");
}

function affinityBranchCorpus(request: TaskRelationAffinityRequest) {
  if (request.affinityKind === "child") {
    const payload = request.semanticPayload as ChildAffinitySemanticPayload;
    return [
      payload.activeChild.question,
      ...payload.activeChild.sourceEvidence,
      ...payload.recentBranchEvidence.map((item) => item.text),
    ].join("\n");
  }
  const payload = request.semanticPayload as ParentAffinitySemanticPayload;
  return [
    payload.activeParent.topic,
    payload.activeParent.objective,
    ...payload.activeParent.acceptedConstraints,
    ...payload.activeParent.sourceEvidence,
    ...payload.recentParentEvidence.map((item) => item.text),
  ].join("\n");
}

function canonicalParentCorpus(payload: CanonicalRelationSemanticPayload) {
  return [
    payload.activeParent.topic,
    payload.activeParent.objective,
    ...payload.activeParent.acceptedConstraints,
    payload.activeChild?.question,
    ...payload.recentEvidence.map((item) => item.text),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function parseJsonObject(rawOutput: string):
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      reason: string;
      errorKind: "parse" | "schema" | "evidence" | "provider";
      evidenceSpansValid: false;
    } {
  const trimmed = stripJsonFence(rawOutput.trim());
  if (!trimmed) return parseFailure("empty-output", "parse");
  if (trimmed.length > TASK_RELATION_SPLIT_MAX_OUTPUT_CHARS) {
    return parseFailure("output-too-large", "parse");
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : parseFailure("output-is-not-object", "schema");
  } catch {
    return parseFailure("invalid-json", "parse");
  }
}

function parseFailure(
  reason: string,
  errorKind: "parse" | "schema" | "evidence" | "provider"
) {
  return {
    ok: false as const,
    reason,
    errorKind,
    evidenceSpansValid: false as const,
  };
}

function isEvidenceArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 4 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        Boolean(item.trim()) &&
        item.trim().length <= 180
    )
  );
}

function normalizeEvidenceArray(value: unknown) {
  return (value as string[]).map((item) => item.trim());
}

function isConfidence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isRuntimeRelation(value: unknown): value is RuntimeTaskRelation {
  return (
    value === "new-parent" ||
    value === "followup-parent" ||
    value === "child-probe" ||
    value === "resume-parent" ||
    value === "unknown"
  );
}

function allSpansGrounded(spans: string[], corpus: string) {
  return spans.every((span) => corpus.includes(span));
}

function stripJsonFence(value: string) {
  return value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim() ?? value;
}

export function isTaskRelationSplitOperationKind(
  value: RuntimeInferenceOperationKind
) {
  return (
    value === "task-relation-child-affinity" ||
    value === "task-relation-parent-affinity" ||
    value === "task-relation-canonical-shadow"
  );
}
