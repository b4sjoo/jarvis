import {
  ActiveInterviewParent,
  ActiveScreenTask,
  AdvisorPromptContext,
  GlossaryEntry,
  InterviewSessionBrief,
  InterviewSessionContext,
  InterviewTargetCompany,
  MeetingContextState,
  ScreenObservation,
  TranscriptTurn,
} from "./types";
import {
  createInterviewSessionContextFromBrief,
  updateInterviewSessionContextFromBrief,
} from "./interview-session-context.js";
import {
  collectConfirmedMeFacts,
  shouldIncludeTurnInAdvisorPrompt,
} from "./transcript-fusion.js";
import {
  cloneMeetingTaskRuntimeState,
  createMeetingTaskRuntimeState,
  projectActiveMeetingTask,
  reduceMeetingTaskRuntimeMutation,
  type MeetingTaskRuntimeMutation,
  type MeetingTaskRuntimeState,
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

type StoredMeetingContextState = Omit<
  MeetingContextState,
  "taskRuntime" | "activeMeetingTask"
>;

export class MeetingContextManager {
  private state: StoredMeetingContextState;
  private taskRuntimeState: MeetingTaskRuntimeState;
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
    this.clearExpiredActiveMeetingTask();
    const activeMeetingTask = this.buildActiveMeetingTask();

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
      taskRuntime: cloneMeetingTaskRuntimeState(this.taskRuntimeState),
      activeMeetingTask,
      glossary: [...this.state.glossary],
    };
  }

  reset(options: MeetingContextManagerOptions = {}) {
    const interviewSessionBrief =
      options.interviewSessionBrief ?? this.state.interviewSessionBrief;
    this.taskRuntimeState = createMeetingTaskRuntimeState();
    this.state = {
      sessionId: createMeetingId("meeting"),
      startedAt: Date.now(),
      transcriptTurns: [],
      screenObservations: [],
      interviewSessionBrief: cloneInterviewSessionBrief(interviewSessionBrief),
      interviewSessionContext:
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

  commitTaskRuntimeTransition(input: {
    id: string;
    transition: MeetingTaskRuntimeTransitionKind;
    reason: string;
    expectedRevision?: number;
    parent?: ActiveInterviewParent | null;
    screenAttachment?: ActiveScreenTask | null;
    appliedAt?: number;
  }) {
    return this.applyTaskRuntimeMutation({
      ...input,
      kind: "commit-transition",
    });
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

  buildAdvisorPromptContext(): AdvisorPromptContext {
    this.clearExpiredActiveMeetingTask();

    const latestTurn =
      this.state.transcriptTurns[this.state.transcriptTurns.length - 1];
    const activeMeetingTask = this.buildActiveMeetingTask();
    const promptTranscriptTurns = this.getPromptTranscriptTurns(
      activeMeetingTask?.parent.promptTranscriptStartTurnId
    );

    return {
      transcript: this.formatTranscriptTurns(promptTranscriptTurns),
      advisorPromptSourceTurnIds: promptTranscriptTurns.map(
        (turn) => turn.id
      ),
      screenContext: this.formatScreenContext(),
      interviewSessionBrief: cloneInterviewSessionBrief(
        this.state.interviewSessionBrief
      ),
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      taskRuntime: cloneMeetingTaskRuntimeState(this.taskRuntimeState),
      activeMeetingTask,
      rollingSummary: this.state.rollingSummary,
      userProfileContext: this.state.userProfileContext,
      glossaryText: this.formatGlossary(),
      interviewPlaybook: activeMeetingTask?.parent.playbook,
      confirmedMeFacts: collectConfirmedMeFacts(this.state.transcriptTurns),
      latestTurn,
    };
  }

  private buildActiveMeetingTask() {
    return projectActiveMeetingTask({
      state: this.taskRuntimeState,
      latestObservation:
        this.state.screenObservations[this.state.screenObservations.length - 1],
    });
  }

  private applyTaskRuntimeMutation(mutation: MeetingTaskRuntimeMutation) {
    const result = reduceMeetingTaskRuntimeMutation({
      state: this.taskRuntimeState,
      mutation,
    });
    this.taskRuntimeState = result.state;
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

  private formatScreenContext() {
    const activeMeetingTask = this.buildActiveMeetingTask();
    const activeTaskContext = activeMeetingTask?.screen
      ? [
          "Active meeting screen context:",
          `Task id: ${activeMeetingTask.id}`,
          `Source: ${activeMeetingTask.source}`,
          `Question type: ${activeMeetingTask.parent.questionType}`,
          activeMeetingTask.parent.topic
            ? `Topic: ${activeMeetingTask.parent.topic}`
            : undefined,
          activeMeetingTask.screen.question
            ? `Screen question: ${activeMeetingTask.screen.question}`
            : undefined,
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
          activeMeetingTask.screen.content,
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const observationContext = this.state.screenObservations
      .map((observation) => {
        const text = observation.visualSummary || observation.ocrText || "";
        return text.trim();
      })
      .filter(Boolean)
      .join("\n\n");

    return [activeTaskContext, observationContext].filter(Boolean).join("\n\n");
  }

  private formatGlossary() {
    return this.state.glossary
      .map((entry) => `${entry.term}: ${entry.definition}`)
      .join("\n");
  }
}

export function createMeetingId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
