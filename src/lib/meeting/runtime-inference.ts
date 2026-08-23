import { RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS } from "./response-opportunity-contract.js";

export type ModelWorkloadClass = "runtime" | "advisor" | "complex";

export type RuntimeInferenceOperationKind =
  | "taxonomy-adjudication"
  | "question-type-adjudication"
  | "response-opportunity-inference"
  | "meeting-metadata-inference"
  | "whiteboard-syntax-repair"
  | "task-relation-adjudication"
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
  lane: RuntimeInferenceLane;
  timeoutMs: number;
  maxOutputTokens: number;
  quiescenceMs: number;
  maxStartsPerBudgetSlot: number;
}

export interface RuntimeInferenceContextSnapshot<TPayload> {
  id: string;
  hash: string;
  sessionId: string;
  runtimeEpoch: number;
  revision: number;
  createdAt: number;
  payload: Readonly<TPayload>;
}

export interface RuntimeInferenceEnvelope {
  requestId: string;
  workloadClass: "runtime";
  operationKind: RuntimeInferenceOperationKind;
  lane: RuntimeInferenceLane;
  contextSnapshotId: string;
  contextSnapshotHash: string;
  sessionId: string;
  runtimeEpoch: number;
  operationRevision: number;
  semanticPayloadDigest: string;
  modelInputArtifactRef?: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface RuntimeInferenceInvocation<TSemanticPayload> {
  envelope: Readonly<RuntimeInferenceEnvelope>;
  semanticPayload: Readonly<TSemanticPayload>;
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
    lane: "critical",
    timeoutMs: 4_000,
    maxOutputTokens: 256,
    quiescenceMs: 450,
    maxStartsPerBudgetSlot: 1,
  },
  "question-type-adjudication": {
    workloadClass: "runtime",
    operationKind: "question-type-adjudication",
    lane: "critical",
    timeoutMs: 3_000,
    maxOutputTokens: 128,
    quiescenceMs: 350,
    maxStartsPerBudgetSlot: 1,
  },
  "response-opportunity-inference": {
    workloadClass: "runtime",
    operationKind: "response-opportunity-inference",
    lane: "critical",
    timeoutMs: 1_500,
    maxOutputTokens: RESPONSE_OPPORTUNITY_MAX_OUTPUT_TOKENS,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "meeting-metadata-inference": {
    workloadClass: "runtime",
    operationKind: "meeting-metadata-inference",
    lane: "background",
    timeoutMs: 4_000,
    maxOutputTokens: 256,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "whiteboard-syntax-repair": {
    workloadClass: "runtime",
    operationKind: "whiteboard-syntax-repair",
    lane: "background",
    timeoutMs: 3_000,
    maxOutputTokens: 768,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "task-relation-adjudication": {
    workloadClass: "runtime",
    operationKind: "task-relation-adjudication",
    lane: "critical",
    timeoutMs: 3_000,
    maxOutputTokens: 256,
    quiescenceMs: 350,
    maxStartsPerBudgetSlot: 1,
  },
  "answer-resolution": {
    workloadClass: "runtime",
    operationKind: "answer-resolution",
    lane: "background",
    timeoutMs: 1_500,
    maxOutputTokens: 256,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "evidence-requirement": {
    workloadClass: "runtime",
    operationKind: "evidence-requirement",
    lane: "background",
    timeoutMs: 1_500,
    maxOutputTokens: 256,
    quiescenceMs: 0,
    maxStartsPerBudgetSlot: 1,
  },
  "source-linkage-adjudication": {
    workloadClass: "runtime",
    operationKind: "source-linkage-adjudication",
    lane: "critical",
    timeoutMs: 1_500,
    maxOutputTokens: 128,
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

export function createRuntimeInferenceContextSnapshot<
  TPayload extends object,
>(input: {
  id: string;
  hash: string;
  sessionId: string;
  runtimeEpoch: number;
  revision: number;
  payload: TPayload;
  createdAt?: number;
}): RuntimeInferenceContextSnapshot<TPayload> {
  return Object.freeze({
    id: input.id,
    hash: input.hash,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    revision: input.revision,
    createdAt: input.createdAt ?? Date.now(),
    payload: Object.freeze({ ...input.payload }) as Readonly<TPayload>,
  });
}

export function createRuntimeInferenceInvocation<TSemanticPayload>(input: {
  requestId: string;
  operationKind: RuntimeInferenceOperationKind;
  contextSnapshot: RuntimeInferenceContextSnapshot<object>;
  operationRevision: number;
  semanticPayload: TSemanticPayload;
}): RuntimeInferenceInvocation<TSemanticPayload> {
  const definition = getRuntimeInferenceOperationDefinition(
    input.operationKind
  );
  const semanticPayload = freezeRuntimeSemanticPayload(
    cloneRuntimeSemanticPayload(input.semanticPayload)
  );
  const envelope = Object.freeze({
    requestId: input.requestId,
    workloadClass: "runtime",
    operationKind: input.operationKind,
    lane: definition.lane,
    contextSnapshotId: input.contextSnapshot.id,
    contextSnapshotHash: input.contextSnapshot.hash,
    sessionId: input.contextSnapshot.sessionId,
    runtimeEpoch: input.contextSnapshot.runtimeEpoch,
    operationRevision: input.operationRevision,
    semanticPayloadDigest: hashRuntimeSemanticPayload(semanticPayload),
    timeoutMs: definition.timeoutMs,
    maxOutputTokens: definition.maxOutputTokens,
  } satisfies RuntimeInferenceEnvelope);
  return Object.freeze({
    envelope,
    semanticPayload,
  });
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

function cloneRuntimeSemanticPayload<T>(value: T): T {
  return JSON.parse(serializeRuntimeSemanticPayload(value)) as T;
}

function freezeRuntimeSemanticPayload<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value as Readonly<T>;
  }
  for (const item of Object.values(value)) {
    freezeRuntimeSemanticPayload(item);
  }
  return Object.freeze(value);
}

export function formatRuntimeInferenceOperationForTrace(
  operationKind: RuntimeInferenceOperationKind
) {
  const definition = getRuntimeInferenceOperationDefinition(operationKind);
  return {
    modelWorkloadClass: definition.workloadClass,
    runtimeInferenceOperationKind: definition.operationKind,
    runtimeInferenceLane: definition.lane,
    runtimeInferenceTimeoutMs: definition.timeoutMs,
    runtimeInferenceMaxOutputTokens: definition.maxOutputTokens,
    runtimeInferenceQuiescenceMs: definition.quiescenceMs,
    runtimeInferenceMaxStartsPerBudgetSlot:
      definition.maxStartsPerBudgetSlot,
  };
}
