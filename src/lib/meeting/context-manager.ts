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
import { shouldIncludeTurnInAdvisorPrompt } from "./transcript-fusion.js";
import { buildActiveMeetingTask } from "./active-meeting-task.js";

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
  private readonly transcriptWindowMs: number;
  private readonly maxScreenObservations: number;

  constructor(options: MeetingContextManagerOptions = {}) {
    this.transcriptWindowMs =
      options.transcriptWindowMs ?? DEFAULT_TRANSCRIPT_WINDOW_MS;
    this.maxScreenObservations =
      options.maxScreenObservations ?? DEFAULT_MAX_SCREEN_OBSERVATIONS;

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
      activeScreenTask: this.state.activeScreenTask
        ? { ...this.state.activeScreenTask }
        : undefined,
      activeInterviewTask: cloneActiveInterviewTask(
        this.state.activeInterviewTask
      ),
      activeMeetingTask,
      glossary: [...this.state.glossary],
    };
  }

  reset(options: MeetingContextManagerOptions = {}) {
    const interviewSessionBrief =
      options.interviewSessionBrief ?? this.state.interviewSessionBrief;
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
    this.state = {
      ...this.state,
      activeScreenTask: { ...task },
    };
  }

  setActiveMeetingTaskState(patch: ActiveMeetingTaskStatePatch) {
    const nextState = { ...this.state };

    if ("activeScreenTask" in patch) {
      nextState.activeScreenTask = patch.activeScreenTask
        ? { ...patch.activeScreenTask }
        : undefined;
    }

    if ("activeInterviewTask" in patch) {
      nextState.activeInterviewTask = cloneActiveInterviewTask(
        patch.activeInterviewTask ?? undefined
      );
    }

    this.state = nextState;
  }

  clearActiveMeetingTask() {
    this.state = {
      ...this.state,
      activeScreenTask: undefined,
      activeInterviewTask: undefined,
    };
  }

  clearActiveScreenTask() {
    this.state = {
      ...this.state,
      activeScreenTask: undefined,
      activeInterviewTask:
        this.state.activeInterviewTask?.source === "screen"
          ? undefined
          : this.state.activeInterviewTask,
    };
  }

  setActiveInterviewTask(task: ActiveInterviewParent) {
    this.state = {
      ...this.state,
      activeInterviewTask: cloneActiveInterviewTask(task),
    };
  }

  clearActiveInterviewTask() {
    this.state = {
      ...this.state,
      activeInterviewTask: undefined,
    };
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
    const task = this.state.activeScreenTask;
    const interviewTask = this.state.activeInterviewTask;
    let changed = false;

    if (task?.expiresAt && task.expiresAt <= now) {
      this.state = {
        ...this.state,
        activeScreenTask: undefined,
        activeInterviewTask:
          interviewTask?.source === "screen" ? undefined : interviewTask,
      };
      changed = true;
    }

    if (
      this.state.activeInterviewTask?.expiresAt &&
      this.state.activeInterviewTask.expiresAt <= now
    ) {
      this.state = {
        ...this.state,
        activeInterviewTask: undefined,
      };
      changed = true;
    }

    return changed;
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

    return {
      transcript: this.formatTranscript(),
      screenContext: this.formatScreenContext(),
      interviewSessionBrief: cloneInterviewSessionBrief(
        this.state.interviewSessionBrief
      ),
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      activeScreenTask: this.state.activeScreenTask
        ? { ...this.state.activeScreenTask }
        : undefined,
      activeInterviewTask: cloneActiveInterviewTask(
        this.state.activeInterviewTask
      ),
      activeMeetingTask,
      rollingSummary: this.state.rollingSummary,
      userProfileContext: this.state.userProfileContext,
      glossaryText: this.formatGlossary(),
      interviewPlaybook:
        activeMeetingTask?.parent.playbook ??
        this.state.activeScreenTask?.playbook ??
        this.state.activeInterviewTask?.playbook,
      latestTurn,
    };
  }

  private buildActiveMeetingTask() {
    return buildActiveMeetingTask({
      activeScreenTask: this.state.activeScreenTask,
      activeInterviewTask: this.state.activeInterviewTask,
      latestObservation:
        this.state.screenObservations[this.state.screenObservations.length - 1],
    });
  }

  private trimTranscriptWindow(turns: TranscriptTurn[]) {
    const newestEndedAt = turns[turns.length - 1]?.endedAt ?? Date.now();
    const cutoff = newestEndedAt - this.transcriptWindowMs;
    return turns.filter((turn) => turn.endedAt >= cutoff);
  }

  private formatTranscript() {
    return this.state.transcriptTurns
      .filter(shouldIncludeTurnInAdvisorPrompt)
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
      : this.state.activeScreenTask
        ? [
            "Active screen task:",
            this.state.activeScreenTask.question
              ? `Question: ${this.state.activeScreenTask.question}`
              : undefined,
            `Kind: ${this.state.activeScreenTask.kind}`,
            this.state.activeScreenTask.language
              ? `Language: ${this.state.activeScreenTask.language}`
              : undefined,
            this.state.activeScreenTask.content,
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
    child: task.child ? { ...task.child } : undefined,
    whiteboardArtifact: task.whiteboardArtifact
      ? { ...task.whiteboardArtifact }
      : undefined,
  };
}
