import type { AdvisorPromptContext, MeetingContextState } from "./meeting-context-contracts.js";

import type {
  ActiveMeetingTask,
  MeetingTaskRuntimeMutation,
  MeetingTaskRuntimeState,
  MeetingTaskDeadlineControl,
  MeetingTaskDeadlineDelta,
} from "./meeting-task-contracts.js";

import { createMeetingId } from "./meeting-id.js";
import {
  ActiveInterviewParent,
  ActiveScreenTask,
  GlossaryEntry,
  InterviewSessionBrief,
  InterviewSessionContext,
  InterviewTargetCompany,
  ScreenObservation,
  TranscriptTurn,
} from "./types";
import {
  createInterviewSessionContextFromBrief,
  updateInterviewSessionContextFromBrief,
} from "./interview-session-context.js";
import { collectConfirmedMeFacts, shouldIncludeTurnInAdvisorPrompt } from "./transcript-fusion.js";
import {
  cloneMeetingTaskRuntimeState,
  createMeetingTaskRuntimeState,
  projectActiveMeetingTask,
  reduceMeetingTaskRuntimeMutation,
  type AnswerArtifactSection,
  type MeetingTaskRuntimeTransitionKind,
} from "./active-meeting-task.js";

const DEFAULT_TRANSCRIPT_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_MAX_SCREEN_OBSERVATIONS = 5;

export interface MeetingContextManagerOptions {
  transcriptWindowMs?: number;
  maxScreenObservations?: number;
  userProfileContext?: string;
  glossary?: GlossaryEntry[];
  interviewSessionBrief?: InterviewSessionBrief;
}

export interface PreparedMeetingTaskRuntimeTransition {
  expectedSessionId: string;
  expectedRevision: number;
  previousState: MeetingTaskRuntimeState;
  result: ReturnType<typeof reduceMeetingTaskRuntimeMutation>;
  deadlineDelta?: MeetingTaskDeadlineDelta;
  installedState?: MeetingTaskRuntimeState;
  previousDeadlineControl?: MeetingTaskDeadlineControl;
  installedDeadlineControl?: MeetingTaskDeadlineControl;
}

export interface PreparedMeetingTaskDeadlineUpdate {
  expectedSessionId: string;
  deadlineDelta: MeetingTaskDeadlineDelta;
  previousDeadlineControl?: MeetingTaskDeadlineControl;
  installedDeadlineControl?: MeetingTaskDeadlineControl;
}

type StoredMeetingContextState = Omit<
  MeetingContextState,
  "taskRuntime" | "activeMeetingTask"
>;

export class MeetingContextManager {
  private state: StoredMeetingContextState;
  private taskRuntimeState: MeetingTaskRuntimeState;
  private taskDeadlineControl: MeetingTaskDeadlineControl = {};
  private readonly transcriptWindowMs: number;
  private readonly maxScreenObservations: number;

  constructor(options: MeetingContextManagerOptions = {}) {
    this.transcriptWindowMs =
      options.transcriptWindowMs ?? DEFAULT_TRANSCRIPT_WINDOW_MS;
    this.maxScreenObservations =
      options.maxScreenObservations ?? DEFAULT_MAX_SCREEN_OBSERVATIONS;

    this.taskRuntimeState = createMeetingTaskRuntimeState();
    this.state = {
      sessionId: createMeetingId("meeting"),
      startedAt: Date.now(),
      transcriptTurns: [],
      screenObservations: [],
      interviewSessionBrief: cloneInterviewSessionBrief(
        options.interviewSessionBrief
      ),
      interviewSessionContext: createInterviewSessionContextFromBrief(
        options.interviewSessionBrief
      ),
      rollingSummary: "",
      userProfileContext: options.userProfileContext ?? "",
      glossary: options.glossary ?? [],
    };
  }

  getState(): MeetingContextState {
    const taskRuntime = this.getTaskRuntimeState();
    const activeMeetingTask = this.buildActiveMeetingTask(taskRuntime);

    return {
      ...this.state,
      transcriptTurns: [...this.state.transcriptTurns],
      screenObservations: [...this.state.screenObservations],
      interviewSessionBrief: cloneInterviewSessionBrief(
        this.state.interviewSessionBrief
      ),
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      taskRuntime,
      activeMeetingTask,
      glossary: [...this.state.glossary],
    };
  }

  reset(options: MeetingContextManagerOptions & {
    sessionId?: string;
    interviewSessionContext?: InterviewSessionContext;
  } = {}) {
    const interviewSessionBrief =
      options.interviewSessionBrief ?? this.state.interviewSessionBrief;
    this.taskRuntimeState = createMeetingTaskRuntimeState();
    this.taskDeadlineControl = {};
    this.state = {
      sessionId: options.sessionId ?? createMeetingId("meeting"),
      startedAt: Date.now(),
      transcriptTurns: [],
      screenObservations: [],
      interviewSessionBrief: cloneInterviewSessionBrief(interviewSessionBrief),
      interviewSessionContext:
        cloneInterviewSessionContext(options.interviewSessionContext) ??
        createInterviewSessionContextFromBrief(interviewSessionBrief),
      rollingSummary: "",
      userProfileContext: options.userProfileContext ?? "",
      glossary: options.glossary ?? [],
    };
  }

  addTranscriptTurn(turn: TranscriptTurn) {
    const trimmedText = turn.text.trim();
    if (!trimmedText) return;

    const nextTurns = this.trimTranscriptWindow([
      ...this.state.transcriptTurns,
      { ...turn, text: trimmedText },
    ]);
    this.state = {
      ...this.state,
      transcriptTurns: nextTurns,
    };
  }

  updateTranscriptTurnText(turnId: string, text: string) {
    const trimmedText = text.trim();
    if (!trimmedText) return false;

    let changed = false;
    const transcriptTurns = this.state.transcriptTurns.map((turn) => {
      if (turn.id !== turnId || turn.text === trimmedText) return turn;
      changed = true;
      return { ...turn, text: trimmedText };
    });

    if (!changed) return false;

    this.state = {
      ...this.state,
      transcriptTurns,
    };
    return true;
  }

  updateTranscriptTurnContext(
    turnId: string,
    updates: Pick<
      TranscriptTurn,
      "contextPromptEligible" | "contextFusionStatus" | "relatedTurnIds"
    >
  ) {
    let changed = false;
    const transcriptTurns = this.state.transcriptTurns.map((turn) => {
      if (turn.id !== turnId) return turn;
      changed = true;
      return { ...turn, ...updates };
    });

    if (!changed) return false;

    this.state = {
      ...this.state,
      transcriptTurns,
    };
    return true;
  }

  addScreenObservation(observation: ScreenObservation) {
    this.state = {
      ...this.state,
      screenObservations: [
        ...this.state.screenObservations,
        observation,
      ].slice(-this.maxScreenObservations),
    };
  }

  updateScreenObservation(
    observationId: string,
    updates: Partial<ScreenObservation>
  ) {
    this.state = {
      ...this.state,
      screenObservations: this.state.screenObservations.map((observation) =>
        observation.id === observationId
          ? { ...observation, ...updates }
          : observation
      ),
    };
  }

  getTaskRuntimeState() {
    return cloneMeetingTaskRuntimeState(this.taskRuntimeState);
  }

  getTaskDeadlineControl(): MeetingTaskDeadlineControl {
    return {
      parent: this.taskDeadlineControl.parent
        ? { ...this.taskDeadlineControl.parent }
        : undefined,
      screen: this.taskDeadlineControl.screen
        ? { ...this.taskDeadlineControl.screen }
        : undefined,
    };
  }

  prepareTaskDeadlineUpdate(input: {
    expectedSessionId: string;
    deadlineDelta: MeetingTaskDeadlineDelta;
  }): PreparedMeetingTaskDeadlineUpdate {
    return {
      expectedSessionId: input.expectedSessionId,
      deadlineDelta: cloneTaskDeadlineDelta(input.deadlineDelta),
    };
  }

  // The caller's existing publication lease authorizes renewal. This boundary
  // validates ownership only, after any task transition in the same transaction.
  installPreparedTaskDeadlineUpdate(prepared: PreparedMeetingTaskDeadlineUpdate) {
    if (prepared.installedDeadlineControl ||
      this.state.sessionId !== prepared.expectedSessionId ||
      !validTaskDeadlineDelta(prepared.deadlineDelta, this.taskRuntimeState)) {
      return false;
    }
    prepared.previousDeadlineControl = this.taskDeadlineControl;
    this.taskDeadlineControl = applyTaskDeadlineDelta(
      this.taskDeadlineControl, prepared.deadlineDelta, this.taskRuntimeState
    );
    prepared.installedDeadlineControl = this.taskDeadlineControl;
    return true;
  }

  rollbackPreparedTaskDeadlineUpdate(prepared: PreparedMeetingTaskDeadlineUpdate) {
    const before = prepared.previousDeadlineControl;
    const installed = prepared.installedDeadlineControl;
    if (!before || !installed) return true;
    if (this.state.sessionId !== prepared.expectedSessionId ||
      !validTaskDeadlineDelta(prepared.deadlineDelta, this.taskRuntimeState)) return false;
    for (const scope of ["parent", "screen"] as const) {
      if (prepared.deadlineDelta[scope] &&
        (this.taskDeadlineControl[scope] !== installed[scope] ||
          (!installed[scope] && this.taskDeadlineControl !== installed))) return false;
    }
    if (this.taskDeadlineControl === installed) {
      this.taskDeadlineControl = before;
    } else {
      const restored = { ...this.taskDeadlineControl };
      for (const scope of ["parent", "screen"] as const) {
        if (prepared.deadlineDelta[scope]) restored[scope] = before[scope];
      }
      this.taskDeadlineControl = restored;
    }
    prepared.previousDeadlineControl = undefined;
    prepared.installedDeadlineControl = undefined;
    return true;
  }

  commitTaskRuntimeTransition(input: {
    id: string;
    transition: MeetingTaskRuntimeTransitionKind;
    authorizedArtifacts?: readonly AnswerArtifactSection[];
    reason: string;
    expectedRevision?: number;
    parent?: ActiveInterviewParent | null;
    screenAttachment?: ActiveScreenTask | null;
    deadlineDelta?: MeetingTaskDeadlineDelta;
    appliedAt?: number;
  }) {
    const prepared = this.prepareTaskRuntimeTransition(input);
    return this.commitPreparedTaskRuntimeTransition(prepared);
  }

  prepareTaskRuntimeTransition(input: {
    id: string;
    transition: MeetingTaskRuntimeTransitionKind;
    authorizedArtifacts?: readonly AnswerArtifactSection[];
    reason: string;
    expectedRevision?: number;
    parent?: ActiveInterviewParent | null;
    screenAttachment?: ActiveScreenTask | null;
    deadlineDelta?: MeetingTaskDeadlineDelta;
    appliedAt?: number;
  }): PreparedMeetingTaskRuntimeTransition {
    const previousState = cloneMeetingTaskRuntimeState(this.taskRuntimeState);
    const deadlineDelta = input.deadlineDelta
      ? cloneTaskDeadlineDelta(input.deadlineDelta)
      : undefined;
    const result = reduceMeetingTaskRuntimeMutation({
      state: previousState,
      deadlineControl: this.taskDeadlineControl,
      mutation: {
        ...input,
        deadlineDelta,
        kind: "commit-transition",
      },
    });
    return {
      expectedSessionId: this.state.sessionId,
      expectedRevision: previousState.revision,
      previousState,
      result,
      deadlineDelta,
    };
  }

  commitPreparedTaskRuntimeTransition(
    prepared: PreparedMeetingTaskRuntimeTransition
  ) {
    if (this.state.sessionId !== prepared.expectedSessionId ||
      this.taskRuntimeState.revision !== prepared.expectedRevision ||
      prepared.installedState) {
      return {
        state: cloneMeetingTaskRuntimeState(this.taskRuntimeState),
        authorized: false,
        mutationApplied: false,
        reason: "revision-mismatch" as const,
      };
    }
    if (!prepared.result.authorized) return prepared.result;
    if (prepared.deadlineDelta &&
      (!prepared.result.mutationApplied ||
        !validTaskDeadlineDelta(prepared.deadlineDelta, prepared.result.state))) {
      return {
        state: cloneMeetingTaskRuntimeState(this.taskRuntimeState),
        authorized: false,
        mutationApplied: false,
        reason: "invalid-transition" as const,
      };
    }
    prepared.previousDeadlineControl = this.taskDeadlineControl;
    if (prepared.result.mutationApplied) this.taskRuntimeState = prepared.result.state;
    prepared.installedState = this.taskRuntimeState;
    this.taskDeadlineControl = applyTaskDeadlineDelta(
      this.taskDeadlineControl, prepared.deadlineDelta, this.taskRuntimeState
    );
    prepared.installedDeadlineControl = this.taskDeadlineControl;
    return prepared.result;
  }

  rollbackPreparedTaskRuntimeTransition(
    prepared: PreparedMeetingTaskRuntimeTransition
  ) {
    if (!prepared.installedState) return true;
    if (
      this.state.sessionId !== prepared.expectedSessionId ||
      this.taskRuntimeState !== prepared.installedState ||
      this.taskDeadlineControl.parent !== prepared.installedDeadlineControl?.parent ||
      this.taskDeadlineControl.screen !== prepared.installedDeadlineControl?.screen ||
      ((!prepared.installedDeadlineControl?.parent || !prepared.installedDeadlineControl?.screen) &&
        this.taskDeadlineControl !== prepared.installedDeadlineControl)
    ) {
      return false;
    }
    if (prepared.result.mutationApplied) this.taskRuntimeState = prepared.previousState;
    this.taskDeadlineControl = prepared.previousDeadlineControl!;
    prepared.installedState = undefined;
    prepared.previousDeadlineControl = undefined;
    prepared.installedDeadlineControl = undefined;
    return true;
  }

  clearTaskRuntime(input: {
    id: string;
    scope: "all" | "screen" | "parent";
    reason: string;
    expectedRevision?: number;
    appliedAt?: number;
  }) {
    return this.applyTaskRuntimeMutation({
      ...input,
      kind: "clear",
    });
  }

  clearInterviewSessionContext() {
    this.state = {
      ...this.state,
      interviewSessionContext: createInterviewSessionContextFromBrief(
        this.state.interviewSessionBrief
      ),
    };
  }

  setInterviewSessionBrief(brief: InterviewSessionBrief | undefined) {
    const interviewContextUpdate = updateInterviewSessionContextFromBrief(
      this.state.interviewSessionContext,
      brief
    );

    this.state = {
      ...this.state,
      interviewSessionBrief: cloneInterviewSessionBrief(brief),
      interviewSessionContext: interviewContextUpdate.context,
    };

    return interviewContextUpdate;
  }

  commitRuntimeInferredTargetCompany(input: {
    expectedSessionId: string;
    targetCompany: Omit<
      InterviewTargetCompany,
      "source" | "updatedAt"
    >;
    updatedAt?: number;
  }):
    | {
        committed: true;
        targetCompany: InterviewTargetCompany;
      }
    | {
        committed: false;
        reason: "session-mismatch" | "company-already-resolved";
      } {
    if (this.state.sessionId !== input.expectedSessionId) {
      return { committed: false, reason: "session-mismatch" };
    }
    if (this.state.interviewSessionContext?.targetCompany) {
      return {
        committed: false,
        reason: "company-already-resolved",
      };
    }

    const targetCompany: InterviewTargetCompany = {
      ...input.targetCompany,
      source: "runtime-inference",
      updatedAt: input.updatedAt ?? Date.now(),
    };
    this.state = {
      ...this.state,
      interviewSessionContext: {
        ...this.state.interviewSessionContext,
        targetCompany,
      },
    };
    return { committed: true, targetCompany: { ...targetCompany } };
  }

  clearExpiredActiveMeetingTask(now = Date.now()) {
    return this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_expire"),
      kind: "expire",
      deadlineControl: this.taskDeadlineControl,
      reason: "active-task-expiration",
      now,
      appliedAt: now,
    }).mutationApplied;
  }

  clearExpiredActiveScreenTask(now = Date.now()) {
    return this.clearExpiredActiveMeetingTask(now);
  }

  updateRollingSummary(rollingSummary: string) {
    this.state = {
      ...this.state,
      rollingSummary,
    };
  }

  updateUserProfileContext(userProfileContext: string) {
    this.state = {
      ...this.state,
      userProfileContext,
    };
  }

  updateGlossary(glossary: GlossaryEntry[]) {
    this.state = {
      ...this.state,
      glossary,
    };
  }

  setLastAdvisorRequestId(lastAdvisorRequestId: string) {
    this.state = {
      ...this.state,
      lastAdvisorRequestId,
    };
  }

  buildAdvisorPromptContext(
    projectTranscript?: (turns: TranscriptTurn[], sessionId: string, task?: ActiveMeetingTask) => string
  ): AdvisorPromptContext {
    const taskRuntime = this.getTaskRuntimeState();
    const latestTurn =
      this.state.transcriptTurns[this.state.transcriptTurns.length - 1];
    const activeMeetingTask = this.buildActiveMeetingTask(taskRuntime);
    const promptTranscriptTurns = this.getPromptTranscriptTurns(
      activeMeetingTask?.parent.promptTranscriptStartTurnId
    );

    return {
      transcript: projectTranscript
        ? projectTranscript(promptTranscriptTurns, this.state.sessionId, activeMeetingTask)
        : this.formatTranscriptTurns(promptTranscriptTurns),
      advisorPromptSourceTurnIds: promptTranscriptTurns.map(
        (turn) => turn.id
      ),
      screenContext: this.formatScreenContext(activeMeetingTask),
      interviewSessionBrief: cloneInterviewSessionBrief(
        this.state.interviewSessionBrief
      ),
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      taskRuntime,
      activeMeetingTask,
      rollingSummary: this.state.rollingSummary,
      userProfileContext: this.state.userProfileContext,
      glossaryText: this.formatGlossary(),
      interviewPlaybook: activeMeetingTask?.parent.playbook,
      confirmedMeFacts: collectConfirmedMeFacts(this.state.transcriptTurns),
      latestTurn,
    };
  }

  private buildActiveMeetingTask(taskRuntime: MeetingTaskRuntimeState) {
    const screenObservationId =
      taskRuntime.screenAttachment?.observationId ??
      taskRuntime.parent?.child?.latestScreenObservationId ??
      taskRuntime.parent?.latestScreenObservationId;
    return projectActiveMeetingTask({
      state: taskRuntime,
      latestObservation: screenObservationId
        ? this.state.screenObservations.find(
            (observation) => observation.id === screenObservationId
          )
        : undefined,
    });
  }

  private applyTaskRuntimeMutation(mutation: MeetingTaskRuntimeMutation) {
    const result = reduceMeetingTaskRuntimeMutation({
      state: this.taskRuntimeState,
      mutation,
    });
    if (result.mutationApplied) {
      this.taskRuntimeState = result.state;
      this.taskDeadlineControl = applyTaskDeadlineDelta(
        this.taskDeadlineControl, undefined, this.taskRuntimeState
      );
    }
    return result;
  }

  private trimTranscriptWindow(turns: TranscriptTurn[]) {
    const newestEndedAt = turns[turns.length - 1]?.endedAt ?? Date.now();
    const cutoff = newestEndedAt - this.transcriptWindowMs;
    return turns.filter((turn) => turn.endedAt >= cutoff);
  }

  private getPromptTranscriptTurns(promptTranscriptStartTurnId?: string) {
    const boundaryIndex = promptTranscriptStartTurnId
      ? this.state.transcriptTurns.findIndex(
          (turn) => turn.id === promptTranscriptStartTurnId
        )
      : -1;
    const scopedTurns =
      boundaryIndex >= 0
        ? this.state.transcriptTurns.slice(boundaryIndex)
        : this.state.transcriptTurns;

    return scopedTurns.filter(shouldIncludeTurnInAdvisorPrompt);
  }

  private formatTranscriptTurns(turns: TranscriptTurn[]) {
    return turns
      .map((turn) => {
        const speaker =
          turn.speaker === "me" ? "Me (clarification)" : "Them";
        return `${speaker}: ${turn.text}`;
      })
      .join("\n");
  }

  private formatScreenContext(activeMeetingTask: ActiveMeetingTask | undefined) {
    const activeTaskContext = activeMeetingTask?.screen
      ? [
          "Active meeting screen context:",
          `Task id: ${activeMeetingTask.id}`,
          `Source: ${activeMeetingTask.source}`,
          `Question type: ${activeMeetingTask.parent.questionType}`,
          activeMeetingTask.screen.language
            ? `Language: ${activeMeetingTask.screen.language}`
            : undefined,
          activeMeetingTask.screen.askFrame
            ? `Ask frame: ${activeMeetingTask.screen.askFrame}`
            : undefined,
          activeMeetingTask.screen.topicDomain
            ? `Topic domain: ${activeMeetingTask.screen.topicDomain}`
            : undefined,
          activeMeetingTask.screen.projectAnchor
            ? `Project anchor: ${activeMeetingTask.screen.projectAnchor}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const activeObservation = activeMeetingTask?.screen?.observationId
      ? this.state.screenObservations.find(
          (observation) =>
            observation.id === activeMeetingTask.screen?.observationId
        )
      : undefined;
    const observationContext = (
      activeObservation?.visualSummary || activeObservation?.ocrText || ""
    ).trim();

    return [activeTaskContext, observationContext].filter(Boolean).join("\n\n");
  }

  private formatGlossary() {
    return this.state.glossary
      .map((entry) => `${entry.term}: ${entry.definition}`)
      .join("\n");
  }
}

function cloneTaskDeadlineDelta(delta: MeetingTaskDeadlineDelta): MeetingTaskDeadlineDelta {
  return {
    parent: delta.parent ? { ...delta.parent } : undefined,
    screen: delta.screen ? { ...delta.screen } : undefined,
  };
}

function validTaskDeadlineDelta(delta: MeetingTaskDeadlineDelta, state: MeetingTaskRuntimeState) {
  return (["parent", "screen"] as const).every((scope) => {
    const update = delta[scope];
    const ownerId = scope === "parent" ? state.parent?.id : state.screenAttachment?.id;
    return !update || (Boolean(ownerId) && update.ownerId === ownerId &&
      (update.deadline === undefined || Number.isFinite(update.deadline)));
  });
}

function applyTaskDeadlineDelta(
  current: MeetingTaskDeadlineControl,
  delta: MeetingTaskDeadlineDelta | undefined,
  state: MeetingTaskRuntimeState
): MeetingTaskDeadlineControl {
  const next = { ...current };
  for (const scope of ["parent", "screen"] as const) {
    const ownerId = scope === "parent" ? state.parent?.id : state.screenAttachment?.id;
    const update = delta?.[scope];
    if (update) {
      next[scope] = update.deadline === undefined
        ? undefined
        : { ownerId: update.ownerId, deadline: update.deadline };
    }
    if (!ownerId || next[scope]?.ownerId !== ownerId) next[scope] = undefined;
  }
  return next;
}

function cloneInterviewSessionContext(
  context: InterviewSessionContext | undefined
) {
  if (!context) return undefined;

  return {
    ...context,
    targetCompany: context.targetCompany
      ? { ...context.targetCompany }
      : undefined,
  };
}

function cloneInterviewSessionBrief(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief) return undefined;

  return {
    ...brief,
    interviewTypes: [...brief.interviewTypes],
  };
}
