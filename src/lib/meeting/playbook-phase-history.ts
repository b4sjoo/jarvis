import type { InterviewPlaybookPhase } from "./types.js";

export type PlaybookPhaseTransitionSource =
  | "automatic"
  | "manual-next"
  | "manual-back";

export interface PlaybookPhaseHistoryEntry {
  operationId: string;
  parentTaskId: string;
  fromPhase: InterviewPlaybookPhase;
  toPhase: InterviewPlaybookPhase;
  source: PlaybookPhaseTransitionSource;
  taskRevision: number;
  phaseRevision: number;
  committedAt: number;
}

export interface ParentPlaybookPhaseHistory {
  parentTaskId: string;
  phaseRevision: number;
  entries: readonly PlaybookPhaseHistoryEntry[];
}

export interface PlaybookPhaseHistoryState {
  maxEntriesPerParent: number;
  parents: Readonly<Record<string, ParentPlaybookPhaseHistory>>;
}

export interface AppendCommittedPlaybookPhaseTransitionInput {
  operationId: string;
  parentTaskId: string;
  fromPhase: InterviewPlaybookPhase;
  toPhase: InterviewPlaybookPhase;
  taskRevision: number;
  expectedPhaseRevision: number;
  committedAt: number;
}

export type AppendPlaybookPhaseTransitionStatus =
  | "appended"
  | "duplicate-operation"
  | "stale-phase-revision"
  | "phase-mismatch"
  | "no-phase-change";

export type AppendPlaybookPhaseTransitionResult =
  | {
      status: "appended";
      state: PlaybookPhaseHistoryState;
      entry: PlaybookPhaseHistoryEntry;
    }
  | {
      status: Exclude<AppendPlaybookPhaseTransitionStatus, "appended">;
      state: PlaybookPhaseHistoryState;
      entry?: PlaybookPhaseHistoryEntry;
      reason: string;
    };

export interface PlaybookPhaseRuntimeSnapshot {
  parentTaskId: string;
  currentPhase: InterviewPlaybookPhase;
  taskRevision: number;
  phaseRevision: number;
  visibleChild?: {
    childTaskId: string;
    parentTaskId: string;
  };
}

export interface ManualPlaybookPhaseBackRequest {
  operationId: string;
  parentTaskId: string;
  expectedTaskRevision: number;
  expectedPhaseRevision: number;
  requestedAt: number;
}

export type ManualPlaybookPhaseNavigationGuardStatus =
  | "ready"
  | "duplicate-operation"
  | "no-history"
  | "no-forward-history"
  | "parent-mismatch"
  | "stale-task-revision"
  | "stale-phase-revision"
  | "phase-history-mismatch";

interface ManualPlaybookPhaseDecisionBase {
  operationId: string;
  parentTaskId: string;
  fromPhase: InterviewPlaybookPhase;
  expectedTaskRevision: number;
  expectedPhaseRevision: number;
  historyDepth: number;
  artifactDisposition: "preserve";
  childPresentationDisposition: "unchanged" | "resume-parent";
  visibleChildTaskId?: string;
  reason: string;
}

export interface ReadyManualPlaybookPhaseBackDecision
  extends ManualPlaybookPhaseDecisionBase {
  status: "ready";
  action: "manual-back";
  targetPhase: InterviewPlaybookPhase;
}

export interface NoopManualPlaybookPhaseBackDecision
  extends ManualPlaybookPhaseDecisionBase {
  status: Exclude<
    ManualPlaybookPhaseNavigationGuardStatus,
    "ready" | "no-forward-history"
  >;
  action: "no-op";
  targetPhase?: undefined;
}

export type ManualPlaybookPhaseBackDecision =
  | ReadyManualPlaybookPhaseBackDecision
  | NoopManualPlaybookPhaseBackDecision;

export interface ManualPlaybookPhaseNextRoundTripRequest {
  operationId: string;
  parentTaskId: string;
  expectedTaskRevision: number;
  expectedPhaseRevision: number;
  requestedAt: number;
}

export interface ReadyManualPlaybookPhaseNextRoundTripDecision
  extends ManualPlaybookPhaseDecisionBase {
  status: "ready";
  action: "manual-next-round-trip";
  targetPhase: InterviewPlaybookPhase;
}

export interface NoopManualPlaybookPhaseNextRoundTripDecision
  extends ManualPlaybookPhaseDecisionBase {
  status: Exclude<
    ManualPlaybookPhaseNavigationGuardStatus,
    "ready" | "no-history"
  >;
  action: "no-op";
  targetPhase?: undefined;
}

export type ManualPlaybookPhaseNextRoundTripDecision =
  | ReadyManualPlaybookPhaseNextRoundTripDecision
  | NoopManualPlaybookPhaseNextRoundTripDecision;

export const DEFAULT_PLAYBOOK_PHASE_HISTORY_LIMIT = 24;

export function createPlaybookPhaseHistoryState(
  maxEntriesPerParent = DEFAULT_PLAYBOOK_PHASE_HISTORY_LIMIT
): PlaybookPhaseHistoryState {
  if (!Number.isInteger(maxEntriesPerParent) || maxEntriesPerParent < 1) {
    throw new Error("maxEntriesPerParent must be a positive integer");
  }
  return {
    maxEntriesPerParent,
    parents: {},
  };
}

export function appendCommittedAutomaticPhaseTransition(
  state: PlaybookPhaseHistoryState,
  input: AppendCommittedPlaybookPhaseTransitionInput
): AppendPlaybookPhaseTransitionResult {
  return appendCommittedPlaybookPhaseTransition(state, input, "automatic");
}

export function appendCommittedManualNextPhaseTransition(
  state: PlaybookPhaseHistoryState,
  input: AppendCommittedPlaybookPhaseTransitionInput
): AppendPlaybookPhaseTransitionResult {
  return appendCommittedPlaybookPhaseTransition(state, input, "manual-next");
}

export function appendCommittedManualBackPhaseTransition(
  state: PlaybookPhaseHistoryState,
  input: AppendCommittedPlaybookPhaseTransitionInput
): AppendPlaybookPhaseTransitionResult {
  return appendCommittedPlaybookPhaseTransition(state, input, "manual-back");
}

export function appendCommittedPlaybookPhaseTransition(
  state: PlaybookPhaseHistoryState,
  input: AppendCommittedPlaybookPhaseTransitionInput,
  source: PlaybookPhaseTransitionSource
): AppendPlaybookPhaseTransitionResult {
  const duplicate = findOperation(state, input.operationId);
  if (duplicate) {
    return {
      status: "duplicate-operation",
      state,
      entry: duplicate,
      reason: `operation ${input.operationId} was already committed`,
    };
  }

  const existing = state.parents[input.parentTaskId];
  const currentPhaseRevision = existing?.phaseRevision ?? 0;
  if (input.expectedPhaseRevision !== currentPhaseRevision) {
    return {
      status: "stale-phase-revision",
      state,
      reason:
        `expected phase revision ${input.expectedPhaseRevision}, ` +
        `current revision is ${currentPhaseRevision}`,
    };
  }

  const latest = existing?.entries[existing.entries.length - 1];
  if (latest && latest.toPhase !== input.fromPhase) {
    return {
      status: "phase-mismatch",
      state,
      reason:
        `latest committed phase is ${latest.toPhase}, ` +
        `transition starts from ${input.fromPhase}`,
    };
  }

  if (input.fromPhase === input.toPhase) {
    return {
      status: "no-phase-change",
      state,
      reason: `coarse phase remains ${input.fromPhase}`,
    };
  }

  const entry: PlaybookPhaseHistoryEntry = {
    operationId: input.operationId,
    parentTaskId: input.parentTaskId,
    fromPhase: input.fromPhase,
    toPhase: input.toPhase,
    source,
    taskRevision: input.taskRevision,
    phaseRevision: currentPhaseRevision + 1,
    committedAt: input.committedAt,
  };
  const entries = [...(existing?.entries ?? []), entry].slice(
    -state.maxEntriesPerParent
  );
  const parent: ParentPlaybookPhaseHistory = {
    parentTaskId: input.parentTaskId,
    phaseRevision: entry.phaseRevision,
    entries,
  };

  return {
    status: "appended",
    state: {
      ...state,
      parents: {
        ...state.parents,
        [input.parentTaskId]: parent,
      },
    },
    entry,
  };
}

export function decideManualPlaybookPhaseBack(input: {
  history: PlaybookPhaseHistoryState;
  request: ManualPlaybookPhaseBackRequest;
  current: PlaybookPhaseRuntimeSnapshot;
}): ManualPlaybookPhaseBackDecision {
  const common = validateNavigationRequest({
    history: input.history,
    operationId: input.request.operationId,
    requestedParentTaskId: input.request.parentTaskId,
    expectedTaskRevision: input.request.expectedTaskRevision,
    expectedPhaseRevision: input.request.expectedPhaseRevision,
    current: input.current,
  });

  if (common.status !== "ready") {
    return {
      ...common,
      action: "no-op",
    };
  }

  if (common.navigation.backStack.length < 2) {
    return {
      ...common.base,
      status: "no-history",
      action: "no-op",
      reason: "no previous committed coarse phase exists for this parent",
    };
  }

  return {
    ...common.base,
    status: "ready",
    action: "manual-back",
    targetPhase:
      common.navigation.backStack[common.navigation.backStack.length - 2],
    reason: "restore the previous committed coarse phase for this parent",
  };
}

export function decideManualPlaybookPhaseNextRoundTrip(input: {
  history: PlaybookPhaseHistoryState;
  request: ManualPlaybookPhaseNextRoundTripRequest;
  current: PlaybookPhaseRuntimeSnapshot;
}): ManualPlaybookPhaseNextRoundTripDecision {
  const common = validateNavigationRequest({
    history: input.history,
    operationId: input.request.operationId,
    requestedParentTaskId: input.request.parentTaskId,
    expectedTaskRevision: input.request.expectedTaskRevision,
    expectedPhaseRevision: input.request.expectedPhaseRevision,
    current: input.current,
  });

  if (common.status !== "ready") {
    return {
      ...common,
      status:
        common.status === "no-history"
          ? "no-forward-history"
          : common.status,
      action: "no-op",
    };
  }

  const targetPhase = common.navigation.forwardStack[0];
  if (!targetPhase) {
    return {
      ...common.base,
      status: "no-forward-history",
      action: "no-op",
      reason: "no phase is available to restore after a manual Back",
    };
  }

  return {
    ...common.base,
    status: "ready",
    action: "manual-next-round-trip",
    targetPhase,
    reason: "restore the phase most recently left by manual Back",
  };
}

export function formatPlaybookPhaseNavigationDecisionForTrace(
  decision:
    | ManualPlaybookPhaseBackDecision
    | ManualPlaybookPhaseNextRoundTripDecision
) {
  return {
    manualPhaseOperationId: decision.operationId,
    manualPhaseDirection:
      decision.action === "manual-back"
        ? "back"
        : decision.action === "manual-next-round-trip"
          ? "next"
          : "none",
    manualPhaseFrom: decision.fromPhase,
    manualPhaseTo: decision.targetPhase,
    manualPhaseHistoryDepth: decision.historyDepth,
    manualPhaseGuardStatus: decision.status,
    manualPhaseCommitApplied: false,
    parentTaskId: decision.parentTaskId,
    taskRevision: decision.expectedTaskRevision,
    phaseRevision: decision.expectedPhaseRevision,
    artifactDisposition: decision.artifactDisposition,
    childPresentationDisposition: decision.childPresentationDisposition,
    visibleChildTaskId: decision.visibleChildTaskId,
    reason: decision.reason,
  };
}

interface NavigationState {
  backStack: InterviewPlaybookPhase[];
  forwardStack: InterviewPlaybookPhase[];
}

type NavigationValidationResult =
  | {
      status: "ready";
      base: ManualPlaybookPhaseDecisionBase;
      navigation: NavigationState;
    }
  | (ManualPlaybookPhaseDecisionBase & {
      status: NavigationValidationFailureStatus;
    });

type NavigationValidationFailureStatus = Exclude<
  ManualPlaybookPhaseNavigationGuardStatus,
  "ready" | "no-forward-history"
>;

function validateNavigationRequest(input: {
  history: PlaybookPhaseHistoryState;
  operationId: string;
  requestedParentTaskId: string;
  expectedTaskRevision: number;
  expectedPhaseRevision: number;
  current: PlaybookPhaseRuntimeSnapshot;
}): NavigationValidationResult {
  const childParentTaskId = input.current.visibleChild?.parentTaskId;
  const parentMatches =
    input.requestedParentTaskId === input.current.parentTaskId &&
    (!childParentTaskId ||
      childParentTaskId === input.current.parentTaskId);
  const parentHistory = input.history.parents[input.requestedParentTaskId];
  const base: ManualPlaybookPhaseDecisionBase = {
    operationId: input.operationId,
    parentTaskId: input.requestedParentTaskId,
    fromPhase: input.current.currentPhase,
    expectedTaskRevision: input.expectedTaskRevision,
    expectedPhaseRevision: input.expectedPhaseRevision,
    historyDepth: parentHistory?.entries.length ?? 0,
    artifactDisposition: "preserve",
    childPresentationDisposition: input.current.visibleChild
      ? "resume-parent"
      : "unchanged",
    visibleChildTaskId: input.current.visibleChild?.childTaskId,
    reason: "",
  };

  if (!parentMatches) {
    return {
      ...base,
      status: "parent-mismatch",
      reason: "manual phase navigation cannot cross a parent boundary",
    };
  }

  const duplicate = parentHistory?.entries.find(
    (entry) => entry.operationId === input.operationId
  );
  if (duplicate) {
    return {
      ...base,
      status: "duplicate-operation",
      reason: `operation ${input.operationId} was already committed`,
    };
  }

  if (input.expectedTaskRevision !== input.current.taskRevision) {
    return {
      ...base,
      status: "stale-task-revision",
      reason:
        `expected task revision ${input.expectedTaskRevision}, ` +
        `current revision is ${input.current.taskRevision}`,
    };
  }

  if (
    input.expectedPhaseRevision !== input.current.phaseRevision ||
    input.expectedPhaseRevision !== (parentHistory?.phaseRevision ?? 0)
  ) {
    return {
      ...base,
      status: "stale-phase-revision",
      reason:
        `expected phase revision ${input.expectedPhaseRevision}, ` +
        `runtime=${input.current.phaseRevision}, ` +
        `history=${parentHistory?.phaseRevision ?? 0}`,
    };
  }

  if (!parentHistory?.entries.length) {
    return {
      ...base,
      status: "no-history",
      reason: "no committed phase transition exists for this parent",
    };
  }

  const navigation = replayPhaseNavigation(parentHistory.entries);
  const derivedCurrentPhase =
    navigation.backStack[navigation.backStack.length - 1];
  if (derivedCurrentPhase !== input.current.currentPhase) {
    return {
      ...base,
      status: "phase-history-mismatch",
      reason:
        `history resolves to ${derivedCurrentPhase ?? "none"}, ` +
        `runtime is ${input.current.currentPhase}`,
    };
  }

  return {
    status: "ready",
    base,
    navigation,
  };
}

function replayPhaseNavigation(
  entries: readonly PlaybookPhaseHistoryEntry[]
): NavigationState {
  const first = entries[0];
  const backStack: InterviewPlaybookPhase[] = first
    ? [first.fromPhase]
    : [];
  let forwardStack: InterviewPlaybookPhase[] = [];

  for (const entry of entries) {
    const current = backStack[backStack.length - 1];
    if (current !== entry.fromPhase) {
      backStack.splice(0, backStack.length, entry.fromPhase);
      forwardStack = [];
    }

    if (entry.source === "manual-back") {
      const prior = backStack[backStack.length - 2];
      if (prior === entry.toPhase) {
        const phaseLeft = backStack.pop();
        if (phaseLeft) forwardStack.unshift(phaseLeft);
      } else {
        forwardStack.unshift(entry.fromPhase);
        backStack.splice(0, backStack.length, entry.toPhase);
      }
      continue;
    }

    if (forwardStack[0] === entry.toPhase) {
      forwardStack = forwardStack.slice(1);
    } else {
      forwardStack = [];
    }
    backStack.push(entry.toPhase);
  }

  return { backStack, forwardStack };
}

function findOperation(
  state: PlaybookPhaseHistoryState,
  operationId: string
): PlaybookPhaseHistoryEntry | undefined {
  for (const parent of Object.values(state.parents)) {
    const entry = parent.entries.find(
      (candidate) => candidate.operationId === operationId
    );
    if (entry) return entry;
  }
  return undefined;
}
