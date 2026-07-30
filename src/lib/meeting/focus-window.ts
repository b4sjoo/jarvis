import type {
  ClarifyingQuestionAnswer,
  ClarifyingQuestionOption,
  InterviewBriefType,
  ManualQuestionTypeCorrection,
  ManualQuestionTypeCorrectionSource,
  MeetingAnswerProfile,
  SpeechCorrection,
} from "./types";
import type { getActiveMeetingTaskFocusSummary } from "./active-meeting-task";
import type { CanonicalQuestionType } from "./task-taxonomy";
import type { NativeAudioPauseResumeControlPresentation } from "./native-audio-lifecycle";
import type { AnswerDeliveryPresentation } from "./stable-answer";

export const MEETING_FOCUS_SNAPSHOT_EVENT = "meeting-focus-snapshot";
export const MEETING_FOCUS_ACTION_EVENT = "meeting-focus-action";
export const FOCUS_CONTROLS_TRANSCRIPT_MEASURE_WIDTH = 840;
export const FOCUS_CONTROLS_CORRECTION_HISTORY_HEIGHT = 24;

export interface FocusControlsGeometryDecision {
  preferredWidth: number;
  preferredHeight: number;
  measuredTranscriptHeight: number;
  estimatedTranscriptHeight: number;
  reservedAuxiliaryHeight: number;
  transcriptScrollRequired: boolean;
}

export function resolveFocusControlsGeometry(input: {
  measuredTranscriptHeight: number;
  reservedAuxiliaryHeight?: number;
  lineHeight?: number;
}): FocusControlsGeometryDecision {
  const lineHeight = Math.max(1, input.lineHeight ?? 20);
  const measuredTranscriptHeight = Math.max(
    lineHeight,
    Math.ceil(input.measuredTranscriptHeight)
  );
  const measuredLines = Math.max(
    1,
    Math.ceil(measuredTranscriptHeight / lineHeight)
  );
  const preferredWidth =
    measuredLines <= 3
      ? 920
      : measuredLines <= 6
        ? 1_080
        : measuredLines <= 10
          ? 1_200
          : 1_280;
  const targetTranscriptWidth = Math.max(1, preferredWidth - 80);
  const estimatedLines = Math.max(
    1,
    Math.ceil(
      (measuredLines * FOCUS_CONTROLS_TRANSCRIPT_MEASURE_WIDTH) /
        targetTranscriptWidth
    )
  );
  const estimatedTranscriptHeight = estimatedLines * lineHeight;
  const maximumVisibleTranscriptHeight = 220;
  const visibleTranscriptHeight = Math.min(
    maximumVisibleTranscriptHeight,
    Math.max(60, estimatedTranscriptHeight)
  );
  const reservedAuxiliaryHeight = Math.max(
    0,
    Math.ceil(input.reservedAuxiliaryHeight ?? 0)
  );
  const preferredHeight = Math.min(
    440,
    230 +
      Math.max(0, visibleTranscriptHeight - 60) +
      reservedAuxiliaryHeight +
      (measuredLines > 10 ? 20 : 0)
  );

  return {
    preferredWidth,
    preferredHeight,
    measuredTranscriptHeight,
    estimatedTranscriptHeight,
    reservedAuxiliaryHeight,
    transcriptScrollRequired:
      estimatedTranscriptHeight > maximumVisibleTranscriptHeight,
  };
}

export function guardAsyncUnlisten(
  registration: Promise<() => void>,
  onError?: (error: unknown) => void
) {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void registration
    .then((registeredUnlisten) => {
      if (disposed) {
        registeredUnlisten();
        return;
      }
      unlisten = registeredUnlisten;
    })
    .catch((error) => {
      onError?.(error);
    });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}

export type MeetingFocusWindowKind = "answer" | "controls";

export type MeetingFocusSectionsSnapshot = {
  chineseThinking: string;
  primaryAnswer: string;
  focusedQuestion: string;
  approach: string;
  whiteboard: string;
  whiteboardViewKey?: string;
  code: string;
  complexity: string;
  clarifyingQuestion: string;
  clarifyingOptions: ClarifyingQuestionOption[];
  profile?: MeetingAnswerProfile;
  hasTechnicalDetails: boolean;
};

export type MeetingFocusSpeechCorrectionSnapshot = Pick<
  SpeechCorrection,
  | "id"
  | "input"
  | "from"
  | "to"
  | "term"
  | "appliedCount"
  | "activeQuestion"
>;

export type MeetingFocusActiveTaskSnapshot = ReturnType<
  typeof getActiveMeetingTaskFocusSummary
>;

export type MeetingFocusSnapshot = {
  active: boolean;
  sections: MeetingFocusSectionsSnapshot;
  latestReliableAnswer: string;
  latestTurnText: string;
  forceAdviseAvailable: boolean;
  forceAdvisePending: boolean;
  forceAdviseCompleted: boolean;
  answerDelivery: AnswerDeliveryPresentation;
  statusLabel: string;
  error: string | null;
  isBusy: boolean;
  audioControl: NativeAudioPauseResumeControlPresentation;
  showClarifyingQuestion: boolean;
  clarifyingQuestion: string;
  selectedClarifyingAnswerLabel?: string;
  isTaskSwitchClarifyingQuestion: boolean;
  interviewTypes: InterviewBriefType[];
  effectiveQuestionType?: CanonicalQuestionType;
  transientPersonalStatusLabel?: string;
  currentQuestionId?: string;
  questionTypeCorrected: boolean;
  manualQuestionTypeCorrection?: ManualQuestionTypeCorrection;
  activeTask?: MeetingFocusActiveTaskSnapshot;
  hasActiveMeetingTask: boolean;
  hasCorrectableQuestion: boolean;
  hasActiveScreenTask: boolean;
  speechCorrections: MeetingFocusSpeechCorrectionSnapshot[];
};

export type MeetingFocusAction =
  | { type: "request-snapshot" }
  | { type: "toggle-listening" }
  | { type: "regenerate" }
  | { type: "force-advise" }
  | { type: "capture-screen" }
  | { type: "submit-correction"; correction: string }
  | {
      type: "correct-question-type";
      correctedType: CanonicalQuestionType;
      source: ManualQuestionTypeCorrectionSource;
    }
  | { type: "update-interview-types"; interviewTypes: InterviewBriefType[] }
  | {
      type: "clarifying-answer";
      answer: ClarifyingQuestionAnswer;
      option?: { label?: string; value?: string };
    }
  | { type: "new-task" }
  | { type: "same-task" }
  | { type: "dismiss-clarifying-question" };

export const EMPTY_MEETING_FOCUS_SNAPSHOT: MeetingFocusSnapshot = {
  active: false,
  sections: {
    chineseThinking: "",
    primaryAnswer: "",
    focusedQuestion: "",
    approach: "",
    whiteboard: "",
    code: "",
    complexity: "",
    clarifyingQuestion: "",
    clarifyingOptions: [],
    profile: undefined,
    hasTechnicalDetails: false,
  },
  latestReliableAnswer: "",
  latestTurnText: "Waiting for meeting audio.",
  forceAdviseAvailable: false,
  forceAdvisePending: false,
  forceAdviseCompleted: false,
  answerDelivery: {
    state: "idle",
    visibleAnswerRevision: 0,
    meSpokenWordEquivalent: 0,
    meAnswerTokenOverlap: 0,
  },
  statusLabel: "Ready",
  error: null,
  isBusy: false,
  audioControl: {
    action: "unavailable",
    label: "Pause",
    title: "Start meeting audio before pausing",
    disabled: true,
    urgent: false,
    busy: false,
  },
  showClarifyingQuestion: false,
  clarifyingQuestion: "",
  selectedClarifyingAnswerLabel: undefined,
  isTaskSwitchClarifyingQuestion: false,
  interviewTypes: [],
  effectiveQuestionType: undefined,
  transientPersonalStatusLabel: undefined,
  questionTypeCorrected: false,
  manualQuestionTypeCorrection: undefined,
  activeTask: undefined,
  hasActiveMeetingTask: false,
  hasCorrectableQuestion: false,
  hasActiveScreenTask: false,
  speechCorrections: [],
};
