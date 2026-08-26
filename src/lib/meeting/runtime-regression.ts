export const RUNTIME_REGRESSION_RUN_SCHEMA_VERSION = 1 as const;
export const RUNTIME_REGRESSION_STEP_SCHEMA_VERSION = 1 as const;

export type RuntimeRegressionRunStatus =
  | "running"
  | "stopped"
  | "error";

export interface RuntimeRegressionRunRecordV1 {
  schemaVersion: typeof RUNTIME_REGRESSION_RUN_SCHEMA_VERSION;
  scenarioRunId: string;
  recordingSessionId?: string;
  runtimeSessionId: string;
  mode: "manual-replay";
  forcedScripted: true;
  status: RuntimeRegressionRunStatus;
  startedAt: number;
  endedAt?: number;
  reason?: string;
}

export type RuntimeRegressionInputKind = "them-text" | "screen";

export type RuntimeRegressionStepTerminalDisposition =
  | "visible"
  | "suppressed"
  | "error"
  | "cancelled"
  | "stale";

export interface RuntimeRegressionStepEventV1 {
  schemaVersion: typeof RUNTIME_REGRESSION_STEP_SCHEMA_VERSION;
  scenarioRunId: string;
  scenarioStepId: string;
  ordinal: number;
  event: "injected" | "terminal";
  inputKind: RuntimeRegressionInputKind;
  runtimeSessionId: string;
  traceId?: string;
  logicalQuestionUnitId?: string;
  settlementId?: string;
  executionPlanId?: string;
  visibleAnswerRevision?: number;
  textChars?: number;
  sourceHash?: string;
  terminalDisposition?: RuntimeRegressionStepTerminalDisposition;
  reason?: string;
  occurredAt: number;
}

export type RuntimeRegressionRunnerStatus =
  | "idle"
  | "starting"
  | "ready"
  | "running-step"
  | "stopping"
  | "error";

export interface RuntimeRegressionRunnerStepPresentation {
  scenarioStepId: string;
  ordinal: number;
  inputKind: RuntimeRegressionInputKind;
  status: "pending" | "visible" | "suppressed" | "error" | "cancelled";
  traceId?: string;
  reason?: string;
}

export interface RuntimeRegressionRunnerPresentation {
  active: boolean;
  status: RuntimeRegressionRunnerStatus;
  scenarioRunId?: string;
  stepOrdinal: number;
  currentStep?: RuntimeRegressionRunnerStepPresentation;
  error?: string;
}

export function createRuntimeRegressionRunRecord(input: {
  scenarioRunId: string;
  runtimeSessionId: string;
  status?: RuntimeRegressionRunStatus;
  startedAt?: number;
  endedAt?: number;
  reason?: string;
}): RuntimeRegressionRunRecordV1 {
  return {
    schemaVersion: RUNTIME_REGRESSION_RUN_SCHEMA_VERSION,
    scenarioRunId: input.scenarioRunId,
    runtimeSessionId: input.runtimeSessionId,
    mode: "manual-replay",
    forcedScripted: true,
    status: input.status ?? "running",
    startedAt: input.startedAt ?? Date.now(),
    endedAt: input.endedAt,
    reason: input.reason,
  };
}

export function createRuntimeRegressionStepEvent(input: Omit<
  RuntimeRegressionStepEventV1,
  "schemaVersion" | "occurredAt"
> & {
  occurredAt?: number;
}): RuntimeRegressionStepEventV1 {
  return {
    schemaVersion: RUNTIME_REGRESSION_STEP_SCHEMA_VERSION,
    ...input,
    occurredAt: input.occurredAt ?? Date.now(),
  };
}
