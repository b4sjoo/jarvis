export const MANUAL_RUNTIME_ACTION_SCHEMA_VERSION = 1 as const;

export type ManualRuntimeActionKind =
  | "type-correction"
  | "force-advise"
  | "next-phase"
  | "previous-phase"
  | "narrow-context"
  | "enhance-context"
  | "regenerate-artifacts"
  | "toggle-advise-pin"
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
  | "no-active-task"
  | "shortcut-debounced"
  | "editable-focus";

export interface ManualRuntimeActionInvocation {
  displayTarget?: import("./manual-advise-display.js").AdviseDisplayTarget;
  uiSurface?: "meeting-response-actions" | "normal-mode" | "focus-mode";
  actionId?: string;
  ingressSource?: "ui" | "shortcut";
  ingressReceivedAt?: number;
  preflightRejectionReason?: Extract<
    ManualRuntimeActionIngressRejectionReason,
    "shortcut-debounced" | "editable-focus"
  >;
}

export interface ManualRuntimeActionIngressDecision {
  authorized: boolean;
  reason?: ManualRuntimeActionIngressRejectionReason;
}

export interface ManualRuntimeActionAdvisorTerminalDecision {
  disposition?: ManualRuntimeActionTerminalDisposition;
  reason: string;
}

export interface ManualRuntimeActionEventV1 {
  schemaVersion: typeof MANUAL_RUNTIME_ACTION_SCHEMA_VERSION;
  actionId: string;
  action: ManualRuntimeActionKind;
  stage: ManualRuntimeActionEventStage;
  runtimeSessionId: string;
  runtimeEpoch: number;
  uiSurface: "meeting-response-actions" | "normal-mode" | "focus-mode";
  occurredAt: number;
  ingressSource?: "ui" | "shortcut";
  ingressReceivedAt?: number;
  traceId?: string;
  observedLogicalQuestionUnitId?: string;
  observedLogicalQuestionUnitRevision?: number;
  observedTaskId?: string;
  observedVisibleAnswerRevision?: number;
  specializedEventId?: string;
  correctedType?: string;
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
  if (input.action === "toggle-advise-pin") {
    return input.hasVisibleAnswer ? { authorized: true } : { authorized: false, reason: "no-visible-answer" };
  }
  if (input.action === "clear-task" || input.action === "force-advise" || input.action === "type-correction") {
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

export function projectManualRuntimeActionAdvisorTerminal(input: {
  traceStatus?: "running" | "success" | "error" | "cancelled";
  advisorOutcome?:
    | "suppressed"
    | "model-completed"
    | "delivery-pending"
    | "visible-committed"
    | "stale-dropped"
    | "cancelled-by-new-job"
    | "cancelled-by-runtime-boundary"
    | "error";
  traceError?: string;
}): ManualRuntimeActionAdvisorTerminalDecision {
  if (input.advisorOutcome === "visible-committed") {
    return { disposition: "completed", reason: "visible-answer-committed" };
  }
  if (input.advisorOutcome === "delivery-pending") {
    return { reason: "delivery-pending" };
  }
  if (input.advisorOutcome === "stale-dropped") {
    return { disposition: "stale", reason: "stale-commit-rejected" };
  }
  if (
    input.advisorOutcome === "cancelled-by-new-job" ||
    input.advisorOutcome === "cancelled-by-runtime-boundary" ||
    input.traceStatus === "cancelled"
  ) {
    return {
      disposition: "cancelled",
      reason: input.advisorOutcome ?? input.traceError ?? "cancelled",
    };
  }
  if (
    input.advisorOutcome === "error" ||
    input.advisorOutcome === "model-completed" ||
    input.advisorOutcome === "suppressed" ||
    input.traceStatus === "error"
  ) {
    return {
      disposition: "failed",
      reason:
        input.traceError ??
        input.advisorOutcome ??
        "visible-answer-not-committed",
    };
  }
  return {
    disposition: "failed",
    reason: input.traceError ?? "advisor-terminal-missing",
  };
}
