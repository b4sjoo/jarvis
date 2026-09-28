import { RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS } from "./response-opportunity-contract.js";

export type ModelWorkloadClass = "runtime" | "advisor" | "complex";

export type RuntimeInferenceProviderTier = "fast" | "intelligent";

export type RuntimeInferenceOperationKind =
  | "taxonomy-adjudication"
  | "question-type-adjudication"
  | "response-opportunity-inference"
  | "project-selection-inference"
  | "meeting-metadata-inference"
  | "whiteboard-syntax-repair"
  | "task-relation-adjudication"
  | "task-relation-child-affinity"
  | "task-relation-parent-affinity"
  | "task-relation-canonical-shadow"
  | "answer-resolution"
  | "evidence-requirement"
  | "source-linkage-adjudication";

export type RuntimeInferenceLane =
  | "critical"
  | "background"
  | "evaluation";

export interface RuntimeInferenceOperationDefinition {
  workloadClass: "runtime";
  operationKind: RuntimeInferenceOperationKind;
  providerTier: RuntimeInferenceProviderTier;
  lane: RuntimeInferenceLane;
  timeoutMs: number;
  maxOutputTokens: number;
  quiescenceMs: number;
  maxStartsPerBudgetSlot: number;
}

export interface RuntimeInferenceModelInput {
  systemPrompt: string;
  userMessage: string;
  semanticPayloadDigest: string;
  modelVisibleChars: number;
}

const RUNTIME_ENVELOPE_ONLY_KEYS = new Set([
  "requestId",
  "operationId",
  "operationKind",
  "providerTier",
  "workloadClass",
  "lane",
  "contextSnapshotId",
  "contextSnapshotHash",
  "sessionId",
  "runtimeEpoch",
  "operationRevision",
  "sourceSettlementId",
  "sourceHash",
  "outputHash",
  "semanticPayloadDigest",
  "modelInputArtifactRef",
  "promptVersion",
  "schemaVersion",
  "timeoutMs",
  "maxOutputTokens",
  "quiescenceMs",
  "budgetKey",
  "budgetSlot",
  "budgetReason",
  "createdAt",
  "startedAt",
  "endedAt",
  "updatedAt",
  "id",
  "rev",
  "v",
  "turnId",
  "sourceTurnIds",
  "omittedSourceTurnIds",
  "projectionReason",
  "selectionReason",
  "sourceScope",
  "recentEvidenceDiagnostics",
  "playbookPhase",
  "manualForceAdvise",
  "diagramKind",
  "sttUncertaintyMarkers",
]);

const DEFINITIONS: Record<
  RuntimeInferenceOperationKind,
  RuntimeInferenceOperationDefinition
> = {
  "taxonomy-adjudication": {
    workloadClass: "runtime",
    operationKind: "taxonomy-adjudication",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 4_000,
    maxOutputTokens: 256,
    quiescenceMs: 450,
    maxStartsPerBudgetSlot: 1,
  },
  "question-type-adjudication": {
    workloadClass: "runtime",
    operationKind: "question-type-adjudication",
    providerTier: "intelligent",
    lane: "critical",
    timeoutMs: 6_000,
    maxOutputTokens: 512,
    quiescenceMs: 350,
    maxStartsPerBudgetSlot: 1,
  },
  "response-opportunity-inference": {
    workloadClass: "runtime",
    operationKind: "response-opportunity-inference",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 3_000,
    maxOutputTokens: RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "meeting-metadata-inference": {
    workloadClass: "runtime",
    operationKind: "meeting-metadata-inference",
    providerTier: "fast",
    lane: "background",
    timeoutMs: 5_000,
    maxOutputTokens: 256,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "project-selection-inference": {
    workloadClass: "runtime",
    operationKind: "project-selection-inference",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 3_000,
    maxOutputTokens: 512,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "whiteboard-syntax-repair": {
    workloadClass: "runtime",
    operationKind: "whiteboard-syntax-repair",
    providerTier: "fast",
    lane: "background",
    timeoutMs: 3_000,
    maxOutputTokens: 768,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "task-relation-adjudication": {
    workloadClass: "runtime",
    operationKind: "task-relation-adjudication",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 5_000,
    maxOutputTokens: 512,
    quiescenceMs: 350,
    maxStartsPerBudgetSlot: 1,
  },
  "task-relation-child-affinity": {
    workloadClass: "runtime",
    operationKind: "task-relation-child-affinity",
    providerTier: "intelligent",
    lane: "evaluation",
    timeoutMs: 7_000,
    maxOutputTokens: 1024,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "task-relation-parent-affinity": {
    workloadClass: "runtime",
    operationKind: "task-relation-parent-affinity",
    providerTier: "intelligent",
    lane: "evaluation",
    timeoutMs: 7_000,
    maxOutputTokens: 1024,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "task-relation-canonical-shadow": {
    workloadClass: "runtime",
    operationKind: "task-relation-canonical-shadow",
    providerTier: "intelligent",
    lane: "evaluation",
    timeoutMs: 6_000,
    maxOutputTokens: 1024,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "answer-resolution": {
    workloadClass: "runtime",
    operationKind: "answer-resolution",
    providerTier: "fast",
    lane: "background",
    timeoutMs: 1_500,
    maxOutputTokens: 512,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "evidence-requirement": {
    workloadClass: "runtime",
    operationKind: "evidence-requirement",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 3_000,
    maxOutputTokens: 256,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "source-linkage-adjudication": {
    workloadClass: "runtime",
    operationKind: "source-linkage-adjudication",
    providerTier: "fast",
    lane: "critical",
    timeoutMs: 2_000,
    maxOutputTokens: 256,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
};

export const RUNTIME_INFERENCE_OPERATION_DEFINITIONS =
  Object.freeze(DEFINITIONS);

export function getRuntimeInferenceOperationDefinition(
  operationKind: RuntimeInferenceOperationKind
) {
  return RUNTIME_INFERENCE_OPERATION_DEFINITIONS[operationKind];
}

export function buildRuntimeInferenceModelInput<TSemanticPayload>(input: {
  systemPrompt: string;
  semanticPayload: TSemanticPayload;
}): RuntimeInferenceModelInput {
  const leakage = findRuntimeEnvelopeLeakage(input.semanticPayload);
  if (leakage.length) {
    throw new Error(
      `Runtime semantic payload contains envelope-only fields: ${leakage.join(", ")}`
    );
  }
  const userMessage = serializeRuntimeSemanticPayload(input.semanticPayload);
  return {
    systemPrompt: input.systemPrompt,
    userMessage,
    semanticPayloadDigest: hashRuntimeSemanticPayload(input.semanticPayload),
    modelVisibleChars: input.systemPrompt.length + userMessage.length,
  };
}

export function serializeRuntimeSemanticPayload(value: unknown) {
  return JSON.stringify(canonicalizeRuntimeSemanticValue(value));
}

export function hashRuntimeSemanticPayload(value: unknown) {
  let hash = 2_166_136_261;
  for (const character of serializeRuntimeSemanticPayload(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function findRuntimeEnvelopeLeakage(value: unknown) {
  const leakedPaths: string[] = [];
  const visit = (candidate: unknown, path: string) => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      const itemPath = path ? `${path}.${key}` : key;
      if (isRuntimeEnvelopeOnlyKey(key)) leakedPaths.push(itemPath);
      visit(item, itemPath);
    }
  };
  visit(value, "");
  return leakedPaths;
}

function isRuntimeEnvelopeOnlyKey(key: string) {
  return (
    RUNTIME_ENVELOPE_ONLY_KEYS.has(key) ||
    /(?:Id|Ids|Revision|Hash|Timestamp|TimeoutMs|BudgetMs|Budget)$/u.test(key)
  );
}

function canonicalizeRuntimeSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeRuntimeSemanticValue);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeRuntimeSemanticValue(item)])
  );
}

export function formatRuntimeInferenceOperationForTrace(
  operationKind: RuntimeInferenceOperationKind
) {
  const definition = getRuntimeInferenceOperationDefinition(operationKind);
  return {
    modelWorkloadClass: definition.workloadClass,
    runtimeInferenceOperationKind: definition.operationKind,
    runtimeInferenceProviderTier: definition.providerTier,
    runtimeInferenceLane: definition.lane,
    runtimeInferenceTimeoutMs: definition.timeoutMs,
    runtimeInferenceMaxOutputTokens: definition.maxOutputTokens,
    runtimeInferenceQuiescenceMs: definition.quiescenceMs,
    runtimeInferenceMaxStartsPerBudgetSlot:
      definition.maxStartsPerBudgetSlot,
  };
}
