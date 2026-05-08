import {
  AdvisorPromptContext,
  GlossaryEntry,
  MeetingContextState,
  ScreenObservation,
  TranscriptTurn,
} from "./types";

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
    return {
      ...this.state,
      transcriptTurns: [...this.state.transcriptTurns],
      screenObservations: [...this.state.screenObservations],
      glossary: [...this.state.glossary],
    };
  }

  reset(options: MeetingContextManagerOptions = {}) {
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

  addTranscriptTurn(turn: TranscriptTurn) {
    const trimmedText = turn.text.trim();
    if (!trimmedText) return;

    this.state = {
      ...this.state,
      transcriptTurns: this.trimTranscriptWindow([
        ...this.state.transcriptTurns,
        { ...turn, text: trimmedText },
      ]),
    };
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
    const latestTurn =
      this.state.transcriptTurns[this.state.transcriptTurns.length - 1];

    return {
      transcript: this.formatTranscript(),
      screenContext: this.formatScreenContext(),
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
    return this.state.screenObservations
      .map((observation) => {
        const text = observation.visualSummary || observation.ocrText || "";
        return text.trim();
      })
      .filter(Boolean)
      .join("\n\n");
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

