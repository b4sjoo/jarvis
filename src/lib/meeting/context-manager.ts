import {
  ActiveInterviewParent,
  ActiveScreenTask,
  AdvisorPromptContext,
  GlossaryEntry,
  InterviewSessionBrief,
  InterviewSessionContext,
  MeetingContextState,
  ScreenObservation,
  TranscriptTurn,
} from "./types";
import {
  createInterviewSessionContextFromBrief,
  updateInterviewSessionContextFromBrief,
  updateInterviewSessionContextFromScreenText,
  updateInterviewSessionContextFromTurn,
} from "./interview-session-context.js";
import {
  collectConfirmedMeFacts,
  shouldIncludeTurnInAdvisorPrompt,
} from "./transcript-fusion.js";
import {
  cloneMeetingTaskRuntimeState,
  createMeetingTaskRuntimeState,
  projectActiveMeetingTask,
  projectLegacyMeetingTaskRoots,
  reduceMeetingTaskRuntimeMutation,
  type MeetingTaskRuntimeMutation,
  type MeetingTaskRuntimeState,
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

export interface ActiveMeetingTaskStatePatch {
  activeScreenTask?: ActiveScreenTask | null;
  activeInterviewTask?: ActiveInterviewParent | null;
}

export class MeetingContextManager {
  private state: MeetingContextState;
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
    const legacyTaskRoots = projectLegacyMeetingTaskRoots(
      this.taskRuntimeState
    );

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
      ...legacyTaskRoots,
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
    const interviewContextUpdate = updateInterviewSessionContextFromTurn(
      this.state.interviewSessionContext,
      { ...turn, text: trimmedText }
    );

    this.state = {
      ...this.state,
      transcriptTurns: nextTurns,
      interviewSessionContext: interviewContextUpdate.context,
    };

    return interviewContextUpdate;
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

  updateInterviewSessionContextFromScreenText(text: string, evidence?: string) {
    const interviewContextUpdate = updateInterviewSessionContextFromScreenText(
      this.state.interviewSessionContext,
      text,
      evidence
    );

    this.state = {
      ...this.state,
      interviewSessionContext: interviewContextUpdate.context,
    };

    return interviewContextUpdate;
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

  setActiveScreenTask(task: ActiveScreenTask) {
    this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_compat"),
      kind: "replace-projection",
      reason: "legacy-set-active-screen-task",
      screenAttachment: task,
    });
  }

  setActiveMeetingTaskState(patch: ActiveMeetingTaskStatePatch) {
    this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_compat"),
      kind: "replace-projection",
      reason: "legacy-set-active-meeting-task-state",
      screenAttachment: patch.activeScreenTask,
      parent: patch.activeInterviewTask,
    });
  }

  clearActiveMeetingTask() {
    this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_clear"),
      kind: "clear",
      scope: "all",
      reason: "clear-active-meeting-task",
    });
  }

  clearActiveScreenTask() {
    this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_clear"),
      kind: "clear",
      scope: "screen",
      reason: "clear-active-screen-task",
    });
  }

  setActiveInterviewTask(task: ActiveInterviewParent) {
    this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_compat"),
      kind: "replace-projection",
      reason: "legacy-set-active-interview-task",
      parent: task,
    });
  }

  clearActiveInterviewTask() {
    this.applyTaskRuntimeMutation({
      id: createMeetingId("task_runtime_clear"),
      kind: "clear",
      scope: "parent",
      reason: "clear-active-interview-task",
    });
  }

  getTaskRuntimeState() {
    return cloneMeetingTaskRuntimeState(this.taskRuntimeState);
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
    const legacyTaskRoots = projectLegacyMeetingTaskRoots(
      this.taskRuntimeState
    );
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
      ...legacyTaskRoots,
      activeMeetingTask,
      rollingSummary: this.state.rollingSummary,
      userProfileContext: this.state.userProfileContext,
      glossaryText: this.formatGlossary(),
      interviewPlaybook:
        activeMeetingTask?.parent.playbook ??
        legacyTaskRoots.activeScreenTask?.playbook ??
        legacyTaskRoots.activeInterviewTask?.playbook,
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
    const legacyTaskRoots = projectLegacyMeetingTaskRoots(
      this.taskRuntimeState
    );
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
      : legacyTaskRoots.activeScreenTask
        ? [
            "Active screen task:",
            legacyTaskRoots.activeScreenTask.question
              ? `Question: ${legacyTaskRoots.activeScreenTask.question}`
              : undefined,
            `Kind: ${legacyTaskRoots.activeScreenTask.kind}`,
            legacyTaskRoots.activeScreenTask.language
              ? `Language: ${legacyTaskRoots.activeScreenTask.language}`
              : undefined,
            legacyTaskRoots.activeScreenTask.content,
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
    companyHistory: context.companyHistory?.map((entry) => ({
      ...entry,
    })),
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

function cloneActiveInterviewTask(
  task: ActiveInterviewParent | undefined
): ActiveInterviewParent | undefined {
  if (!task) return undefined;

  return {
    ...task,
    playbook: task.playbook ? { ...task.playbook } : undefined,
    phaseProgress: { ...task.phaseProgress },
    projectBinding: task.projectBinding
      ? {
          ...task.projectBinding,
          evidenceEntryIds: [...task.projectBinding.evidenceEntryIds],
        }
      : undefined,
    supportedFactAnchors: [...task.supportedFactAnchors],
    canonicalQuestionSourceTurnIds: task.canonicalQuestionSourceTurnIds
      ? [...task.canonicalQuestionSourceTurnIds]
      : undefined,
    child: task.child
      ? {
          ...task.child,
          basedOnTurnIds: [...task.child.basedOnTurnIds],
          basedOnObservationIds: [...task.child.basedOnObservationIds],
          returnCapsule: task.child.returnCapsule
            ? {
                ...task.child.returnCapsule,
                allowedFactAnchorIds: [
                  ...task.child.returnCapsule.allowedFactAnchorIds,
                ],
                artifactCompatibility: {
                  ...task.child.returnCapsule.artifactCompatibility,
                },
              }
            : undefined,
        }
      : undefined,
    whiteboardArtifact: task.whiteboardArtifact
      ? { ...task.whiteboardArtifact }
      : undefined,
    parentContextHandoff: task.parentContextHandoff
      ? {
          ...task.parentContextHandoff,
          sharedScenarioContext: {
            ...task.parentContextHandoff.sharedScenarioContext,
            domainEntities:
              task.parentContextHandoff.sharedScenarioContext.domainEntities
                ? [
                    ...task.parentContextHandoff.sharedScenarioContext
                      .domainEntities,
                  ]
                : undefined,
            applicableScaleAssumptions:
              task.parentContextHandoff.sharedScenarioContext.applicableScaleAssumptions?.map(
                (item) => ({ ...item })
              ),
            sharedRequirements:
              task.parentContextHandoff.sharedScenarioContext.sharedRequirements
                ? [
                    ...task.parentContextHandoff.sharedScenarioContext
                      .sharedRequirements,
                  ]
                : undefined,
          },
          excludedContextKinds: [
            ...task.parentContextHandoff.excludedContextKinds,
          ],
        }
      : undefined,
  };
}
