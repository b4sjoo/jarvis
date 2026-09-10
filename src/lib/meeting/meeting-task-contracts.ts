import type {
  ActiveBranchPhaseState,
  ActiveInterviewParent,
  ActiveScreenTask,
  InterviewPlaybookPhase,
  InterviewSubtaskIntent,
  ParentContextHandoff,
  ParentReturnCapsule,
  ProjectBinding,
  ScreenCaptureTarget,
  ScreenQuestionType,
  SelectedInterviewPlaybook,
  TaskAskFrame,
  TaskTopicDomain,
  WhiteboardArtifact,
} from "./types.js";
import type {
  AnswerArtifactSection,
  MeetingTaskRuntimeTransitionKind,
} from "./meeting-task-runtime-transition.js";

export type ActiveMeetingTaskSource = "screen" | "voice" | "mixed";

export interface ActiveMeetingTask {
  id: string;
  runtimeRevision: number;
  source: ActiveMeetingTaskSource;
  parent: ActiveMeetingParent;
  child?: ActiveMeetingChild;
  screen?: ActiveMeetingScreenContext;
  divergence?: ActiveMeetingTaskDivergence;
}

export interface ActiveMeetingParent {
  id: string;
  questionType: ScreenQuestionType;
  topic: string;
  playbook?: SelectedInterviewPlaybook;
  playbookPhase: InterviewPlaybookPhase;
  phaseProgress: Record<string, boolean>;
  projectBinding?: ProjectBinding;
  supportedFactAnchors: string[];
  // Generated read projection supplied by the output owner, never stored in Task Runtime.
  latestUsefulAnswer?: string;
  previousUsefulAnswer?: string;
  whiteboardArtifact?: WhiteboardArtifact;
  createdAt: number;
  updatedAt: number;
  originQuestionId?: string;
  startTurnId?: string;
  startObservationId?: string;
  latestScreenObservationId?: string;
  promptTranscriptStartTurnId?: string;
  canonicalQuestionSourceTurnIds?: string[];
  sourceQuestionUnitId?: string;
  sourceQuestionRevision?: number;
  settlementId?: string;
  parentContextHandoff?: ParentContextHandoff;
  revisions?: number;
}

export interface ActiveMeetingChild {
  id: string;
  createdAt: number;
  updatedAt: number;
  questionType: ScreenQuestionType;
  relation: "child-probe";
  intent: InterviewSubtaskIntent;
  question: string;
  compactSummary?: string;
  artifactId?: string;
  basedOnTurnIds: string[];
  basedOnObservationIds: string[];
  latestScreenObservationId?: string;
  returnCapsule?: ParentReturnCapsule;
  phaseState?: ActiveBranchPhaseState;
}

export interface ActiveMeetingScreenContext {
  activeScreenTaskId: string;
  observationId: string;
  basedOnObservationId: string;
  captureTarget?: ScreenCaptureTarget;
  language?: string;
  question?: string;
  askFrame?: TaskAskFrame;
  topicDomain?: TaskTopicDomain;
  projectAnchor?: string;
  classifierConfidence?: number;
  latestScreenAnswer?: string;
  content?: string;
}

export interface ActiveMeetingTaskDivergence {
  reason: "question-type-mismatch" | "screen-observation-mismatch";
  screenTaskId?: string;
  interviewParentId?: string;
  screenQuestionType?: ScreenQuestionType;
  parentQuestionType?: ScreenQuestionType;
}

export interface ActiveMeetingTaskIdentityResolution {
  taskId?: string;
  parentTaskId?: string;
  childTaskId?: string;
  taskSource?: ActiveMeetingTaskSource;
}

export interface MeetingTaskRuntimeState {
  revision: number;
  parent?: ActiveInterviewParent;
  screenAttachment?: ActiveScreenTask;
  lastMutation?: MeetingTaskRuntimeMutationReceipt;
}

export interface MeetingTaskDeadlineControl {
  parent?: { ownerId: string; deadline: number };
  screen?: { ownerId: string; deadline: number };
}

export interface MeetingTaskDeadlineDelta {
  parent?: { ownerId: string; deadline: number | undefined };
  screen?: { ownerId: string; deadline: number | undefined };
}

export interface MeetingTaskRuntimeMutationReceipt {
  id: string;
  kind: MeetingTaskRuntimeMutation["kind"];
  reason: string;
  appliedAt: number;
}

interface MeetingTaskRuntimeMutationBase {
  id: string;
  reason: string;
  expectedRevision?: number;
  appliedAt?: number;
}

export type MeetingTaskRuntimeMutation =
  | (MeetingTaskRuntimeMutationBase & {
      kind: "clear";
      scope: "all" | "parent" | "screen";
    })
  | (MeetingTaskRuntimeMutationBase & {
      kind: "expire";
      now: number;
      deadlineControl: MeetingTaskDeadlineControl;
    })
  | (MeetingTaskRuntimeMutationBase & {
      kind: "commit-transition";
      transition: MeetingTaskRuntimeTransitionKind;
      authorizedArtifacts?: readonly AnswerArtifactSection[];
      parent?: ActiveInterviewParent | null;
      screenAttachment?: ActiveScreenTask | null;
      deadlineDelta?: MeetingTaskDeadlineDelta;
    });

export interface MeetingTaskRuntimeMutationResult {
  state: MeetingTaskRuntimeState;
  authorized: boolean;
  mutationApplied: boolean;
  reason:
    | "committed"
    | "preserved"
    | "revision-mismatch"
    | "invalid-transition"
    | "parent-type-not-allowed"
    | "child-type-not-allowed";
}
