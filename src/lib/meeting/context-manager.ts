import {
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
} from "./interview-session-context";
import { shouldIncludeTurnInAdvisorPrompt } from "./transcript-fusion";

const DEFAULT_TRANSCRIPT_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_MAX_SCREEN_OBSERVATIONS = 5;

export interface MeetingContextManagerOptions {
  transcriptWindowMs?: number;
  maxScreenObservations?: number;
  userProfileContext?: string;
  glossary?: GlossaryEntry[];
  interviewSessionBrief?: InterviewSessionBrief;
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
    this.clearExpiredActiveScreenTask();

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

  clearActiveScreenTask() {
    this.state = {
      ...this.state,
      activeScreenTask: undefined,
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
      interviewSessionBrief: cloneInterviewSessionBrief(
        this.state.interviewSessionBrief
      ),
      interviewSessionContext: cloneInterviewSessionContext(
        this.state.interviewSessionContext
      ),
      activeScreenTask: this.state.activeScreenTask
        ? { ...this.state.activeScreenTask }
        : undefined,
      rollingSummary: this.state.rollingSummary,
      userProfileContext: this.state.userProfileContext,
      glossaryText: this.formatGlossary(),
      interviewPlaybook: this.state.activeScreenTask?.playbook,
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
      .filter(shouldIncludeTurnInAdvisorPrompt)
      .map((turn) => {
        const speaker =
          turn.speaker === "me" ? "Me (clarification)" : "Them";
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

function cloneInterviewSessionBrief(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief) return undefined;

  return {
    ...brief,
    interviewTypes: [...brief.interviewTypes],
  };
}
