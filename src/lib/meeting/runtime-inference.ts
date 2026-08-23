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

export interface RuntimeInferenceRequest<TInput> {
  requestId: string;
  workloadClass: "runtime";
  operationKind: RuntimeInferenceOperationKind;
  lane: RuntimeInferenceLane;
  contextSnapshotId: string;
  contextSnapshotHash: string;
  sessionId: string;
  runtimeEpoch: number;
  operationRevision: number;
  input: TInput;
  timeoutMs: number;
  maxOutputTokens: number;
}

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

export function createRuntimeInferenceRequest<TInput>(input: {
  requestId: string;
  operationKind: RuntimeInferenceOperationKind;
  contextSnapshot: RuntimeInferenceContextSnapshot<object>;
  operationRevision: number;
  input: TInput;
}): RuntimeInferenceRequest<TInput> {
  const definition = getRuntimeInferenceOperationDefinition(
    input.operationKind
  );
  return {
    requestId: input.requestId,
    workloadClass: "runtime",
    operationKind: input.operationKind,
    lane: definition.lane,
    contextSnapshotId: input.contextSnapshot.id,
    contextSnapshotHash: input.contextSnapshot.hash,
    sessionId: input.contextSnapshot.sessionId,
    runtimeEpoch: input.contextSnapshot.runtimeEpoch,
    operationRevision: input.operationRevision,
    input: input.input,
    timeoutMs: definition.timeoutMs,
    maxOutputTokens: definition.maxOutputTokens,
  };
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
