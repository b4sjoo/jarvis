export const MANUAL_RUNTIME_ACTION_SCHEMA_VERSION = 1 as const;

export type ManualRuntimeActionKind =
  | "force-advise"
  | "next-phase"
  | "previous-phase"
  | "narrow-context"
  | "enhance-context"
  | "clear-task"
  | "regenerate";

export type ManualRuntimeActionEventStage =
  | "requested"
  | "accepted"
  | "terminal";

export type ManualRuntimeActionTerminalDisposition =
  | "completed"
  | "rejected"
  | "stale"
  | "failed"
  | "cancelled";

export interface ManualRuntimeActionEventV1 {
  schemaVersion: typeof MANUAL_RUNTIME_ACTION_SCHEMA_VERSION;
  actionId: string;
  action: ManualRuntimeActionKind;
  stage: ManualRuntimeActionEventStage;
  runtimeSessionId: string;
  runtimeEpoch: number;
  uiSurface: "meeting-response-actions";
  occurredAt: number;
  traceId?: string;
  observedLogicalQuestionUnitId?: string;
  observedLogicalQuestionUnitRevision?: number;
  observedTaskId?: string;
  observedVisibleAnswerRevision?: number;
  specializedEventId?: string;
  terminalDisposition?: ManualRuntimeActionTerminalDisposition;
  reason?: string;
}

export function createManualRuntimeActionEvent(
  input: Omit<
    ManualRuntimeActionEventV1,
    "schemaVersion" | "uiSurface" | "occurredAt"
  > & {
    occurredAt?: number;
    uiSurface?: ManualRuntimeActionEventV1["uiSurface"];
  }
): ManualRuntimeActionEventV1 {
  return {
    schemaVersion: MANUAL_RUNTIME_ACTION_SCHEMA_VERSION,
    ...input,
    uiSurface: input.uiSurface ?? "meeting-response-actions",
    occurredAt: input.occurredAt ?? Date.now(),
  };
}

export function manualRuntimeActionEventIsReplayInput(
  event: ManualRuntimeActionEventV1
) {
  return event.stage === "requested";
}
