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

export type ManualRuntimeActionIngressRejectionReason =
  | "meeting-busy"
  | "no-meeting-context"
  | "no-visible-answer"
  | "no-active-task";

export interface ManualRuntimeActionIngressDecision {
  authorized: boolean;
  reason?: ManualRuntimeActionIngressRejectionReason;
}

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

export function decideManualRuntimeActionIngress(input: {
  action: ManualRuntimeActionKind;
  busy: boolean;
  hasMeetingContext: boolean;
  hasVisibleAnswer: boolean;
  hasActiveTask: boolean;
}): ManualRuntimeActionIngressDecision {
  if (input.action === "clear-task" || input.action === "force-advise") {
    return { authorized: true };
  }
  if (input.busy) return { authorized: false, reason: "meeting-busy" };
  if (input.action === "regenerate") {
    return input.hasMeetingContext
      ? { authorized: true }
      : { authorized: false, reason: "no-meeting-context" };
  }
  if (!input.hasVisibleAnswer) {
    return { authorized: false, reason: "no-visible-answer" };
  }
  if (!input.hasActiveTask) {
    return { authorized: false, reason: "no-active-task" };
  }
  return { authorized: true };
}
