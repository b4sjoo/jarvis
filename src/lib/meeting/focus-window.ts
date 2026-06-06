import type {
  ClarifyingQuestionAnswer,
  ClarifyingQuestionOption,
  InterviewBriefType,
  SpeechCorrection,
} from "./types";

export const MEETING_FOCUS_SNAPSHOT_EVENT = "meeting-focus-snapshot";
export const MEETING_FOCUS_ACTION_EVENT = "meeting-focus-action";

export type MeetingFocusWindowKind = "answer" | "controls";

export type MeetingFocusSectionsSnapshot = {
  chineseThinking: string;
  answer: string;
  reply: string;
  code: string;
  complexity: string;
  question: string;
  clarifyingOptions: ClarifyingQuestionOption[];
  isScreenTask: boolean;
};

export type MeetingFocusSpeechCorrectionSnapshot = Pick<
  SpeechCorrection,
  "id" | "input" | "from" | "to" | "term" | "appliedCount"
>;

export type MeetingFocusSnapshot = {
  active: boolean;
  sections: MeetingFocusSectionsSnapshot;
  latestTurnText: string;
  statusLabel: string;
  error: string | null;
  isBusy: boolean;
  showClarifyingQuestion: boolean;
  clarifyingQuestion: string;
  isTaskSwitchClarifyingQuestion: boolean;
  interviewTypes: InterviewBriefType[];
  speechCorrections: MeetingFocusSpeechCorrectionSnapshot[];
};

export type MeetingFocusAction =
  | { type: "request-snapshot" }
  | { type: "toggle-listening" }
  | { type: "regenerate" }
  | { type: "capture-screen" }
  | { type: "submit-correction"; correction: string }
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
    answer: "",
    reply: "",
    code: "",
    complexity: "",
    question: "",
    clarifyingOptions: [],
    isScreenTask: false,
  },
  latestTurnText: "Waiting for meeting audio.",
  statusLabel: "Ready",
  error: null,
  isBusy: false,
  showClarifyingQuestion: false,
  clarifyingQuestion: "",
  isTaskSwitchClarifyingQuestion: false,
  interviewTypes: [],
  speechCorrections: [],
};
