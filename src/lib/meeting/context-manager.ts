import {
  ActiveScreenTask,
  AdvisorPromptContext,
  GlossaryEntry,
  InterviewSessionContext,
  MeetingContextState,
  ScreenObservation,
  TranscriptTurn,
} from "./types";
import {
  updateInterviewSessionContextFromScreenText,
  updateInterviewSessionContextFromTurn,
} from "./interview-session-context";

const DEFAULT_TRANSCRIPT_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_MAX_SCREEN_OBSERVATIONS = 5;

export interface MeetingContextManagerOptions {
  transcriptWindowMs?: number;
  maxScreenObservations?: number;
  userProfileContext?: string;
  glossary?: GlossaryEntry[];
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
      rollingSummary: "",
      userProfileContext: options.userProfileContext ?? "",
      glossary: options.glossary ?? [],
    };
  }

  getState(): MeetingContextState {
    this.clearExpiredActiveScreenTask();

    return {
      ...this.state,
      transcriptTurns: [...this.state.transcriptTurns],
      screenObservations: [...this.state.screenObservations],
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      activeScreenTask: this.state.activeScreenTask
        ? { ...this.state.activeScreenTask }
        : undefined,
      glossary: [...this.state.glossary],
    };
  }

  reset(options: MeetingContextManagerOptions = {}) {
    this.state = {
      sessionId: createMeetingId("meeting"),
      startedAt: Date.now(),
      transcriptTurns: [],
      screenObservations: [],
      interviewSessionContext: undefined,
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

  clearActiveScreenTask() {
    this.state = {
      ...this.state,
      activeScreenTask: undefined,
    };
  }

  clearInterviewSessionContext() {
    this.state = {
      ...this.state,
      interviewSessionContext: undefined,
    };
  }

  clearExpiredActiveScreenTask(now = Date.now()) {
    const task = this.state.activeScreenTask;

    if (!task?.expiresAt || task.expiresAt > now) {
      return false;
    }

    this.clearActiveScreenTask();
    return true;
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
    this.clearExpiredActiveScreenTask();

    const latestTurn =
      this.state.transcriptTurns[this.state.transcriptTurns.length - 1];

    return {
      transcript: this.formatTranscript(),
      screenContext: this.formatScreenContext(),
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      activeScreenTask: this.state.activeScreenTask
        ? { ...this.state.activeScreenTask }
        : undefined,
      rollingSummary: this.state.rollingSummary,
      userProfileContext: this.state.userProfileContext,
      glossaryText: this.formatGlossary(),
      latestTurn,
    };
  }

  private trimTranscriptWindow(turns: TranscriptTurn[]) {
    const newestEndedAt = turns[turns.length - 1]?.endedAt ?? Date.now();
    const cutoff = newestEndedAt - this.transcriptWindowMs;
    return turns.filter((turn) => turn.endedAt >= cutoff);
  }

  private formatTranscript() {
    return this.state.transcriptTurns
      .map((turn) => {
        const speaker = turn.speaker === "me" ? "Me" : "Them";
        return `${speaker}: ${turn.text}`;
      })
      .join("\n");
  }

  private formatScreenContext() {
    const activeTaskContext = this.state.activeScreenTask
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
