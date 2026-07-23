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

export const MEETING_FOCUS_SNAPSHOT_EVENT = "meeting-focus-snapshot";
export const MEETING_FOCUS_ACTION_EVENT = "meeting-focus-action";

export type MeetingFocusWindowKind = "answer" | "controls";

export type MeetingFocusSectionsSnapshot = {
  chineseThinking: string;
  primaryAnswer: string;
  focusedQuestion: string;
  approach: string;
  whiteboard: string;
  code: string;
  complexity: string;
  clarifyingQuestion: string;
  clarifyingOptions: ClarifyingQuestionOption[];
  profile?: MeetingAnswerProfile;
  hasTechnicalDetails: boolean;
};

export type MeetingFocusSpeechCorrectionSnapshot = Pick<
  SpeechCorrection,
  "id" | "input" | "from" | "to" | "term" | "appliedCount"
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
  questionTypeCorrected: false,
  manualQuestionTypeCorrection: undefined,
  activeTask: undefined,
  hasActiveMeetingTask: false,
  hasCorrectableQuestion: false,
  hasActiveScreenTask: false,
  speechCorrections: [],
};
