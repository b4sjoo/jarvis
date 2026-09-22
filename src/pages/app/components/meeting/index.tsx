import {
  Badge,
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Slider,
  Switch,
  Textarea,
} from "@/components";
import { STORAGE_KEYS } from "@/config";
import { useMeetingAssistant, useShortcuts, useWindowResize } from "@/hooks";
import type { GlobalShortcutInvocation } from "@/hooks/useGlobalShortcuts";
import type {
  ClarifyingQuestionAnswer,
  ClarifyingQuestionOption,
  ClarifyingSelectionLifecycleState,
  CanonicalQuestionType,
  AdvisorSuggestion,
  HumanEvalFailureReason,
  HumanEvalQuestionType,
  HumanEvaluationProjectionV2,
  HumanEvaluationTaskRelation,
  HumanExpectedParentAction,
  HumanGroundTruthFactV2,
  HumanGroundTruthInteractionV2,
  InterviewBriefType,
  InterviewSessionBrief,
  InterviewTargetCompany,
  MeetingAudioConfig,
  MeetingAudioProfile,
  AudioInputLivenessPresentation,
  NativeAudioDebugFaultKind,
  NativeAudioPauseResumeControlPresentation,
  MeetingCodingModelSettings,
  MeetingTaxonomyAdjudicationSettings,
  CodingArtifactCache,
  CriticalMomentCandidate,
  CriticalMomentExpectedFacts,
  CriticalMomentEvaluation,
  CriticalMomentOutcomeEvaluationPatch,
  CriticalMomentFailureReason,
  DisplayTranscriptHistoryEntry,
  FactAnchorState,
  InterviewPlaybookPhase,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  MeetingResponseLanguage,
  MeetingResponseLength,
  MeetingSessionRecordingState,
  SttEvaluationCaptureState,
  MeetingFocusUserAction,
  MeetingFocusSnapshot,
  ParsedMeetingAnswer,
  MeetingTrace,
  MeetingTraceKindSummary,
  MeetingTraceSummary,
  MeetingTraceValueSummary,
  MeetingMetadataEvaluationErrorKind,
  MeetingMetadataMutationDisposition,
  MemoryEntryEvaluationLabelValue,
  MemoryRetrievalEvaluationSnapshotResolution,
  PreparationArtifactEvaluation,
  PreparationArtifactEvaluationLabel,
  PreparationArtifactUseReceipt,
  PreparationRuntimePresentation,
  PersonalEvidenceGuardrailMode,
  ProjectTrajectoryChildContinuity,
  SemanticTaxonomyMode,
  ScreenCaptureTarget,
  SpeechCorrection,
  AnswerDeliveryPresentation,
  RuntimeRegressionRunnerPresentation,
} from "@/lib/meeting";
import { buildHumanEvaluationAttemptEvidenceV2 } from "@/lib/meeting/human-evaluation-attempt-projection";
import {
  MEETING_FOCUS_ACTION_EVENT,
  MEETING_FOCUS_SNAPSHOT_EVENT,
  getActiveMeetingParentQuestionType,
  buildClarifyingOptionDisplayModel,
  getActiveMeetingTaskFocusSummary,
  getActiveMeetingTaskId,
  hasManualQuestionTypeCorrectionPresentationTarget,
  buildMeetingAnswerDisplayModel,
  decideForceAdviseEligibility,
  evaluateTaskSettlementTupleCompatibilityV2,
  findQuestionHumanEvaluationForTrace,
  freezeObservedTaskOwnerIdentityV2,
  normalizeCanonicalQuestionType,
  overlayMeetingAnswerArtifacts,
  projectQuestionTypeObservation,
  projectMeetingMetadataEvaluationObservation,
  resolveMeetingAnswerProfile,
  resolveCriticalMomentExpectedFacts,
  resolveNativeAudioPauseResumeControl,
  resolveNativeAudioPrimaryControlAction,
  resolveCodingArtifactDisplay,
  resolveWhiteboardArtifactDisplay,
  readProjectBindingClarifyingCandidates,
  resolveSettledAttemptEvaluationTarget,
  resolveTraceMemoryEvaluationSnapshot,
  selectPreparationArtifactUseReceiptsForEvaluation,
  stripOuterCodeFence,
  summarizeMeetingTraces,
  updateCodingArtifactCache,
} from "@/lib/meeting";
import { extractVariables, safeLocalStorage } from "@/lib";
import { cn } from "@/lib/utils";
import type { TYPE_PROVIDER } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ActivityIcon,
  BrainIcon,
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  EyeOffIcon,
  FileTextIcon,
  HelpCircleIcon,
  LanguagesIcon,
  Loader2Icon,
  MicIcon,
  MessageSquareTextIcon,
  MousePointer2Icon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  Trash2Icon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WhiteboardViewer } from "./whiteboard-viewer";
import { createMeetingFocusPublisher } from "@/lib/meeting/focus-window-protocol";
import { FactGuardrailNotice } from "./fact-guardrail-notice";
import { PhaseOutputNotice } from "./phase-output-notice";
import { AdvisePinButton } from "./advise-pin-button";
import { createMeetingFocusDisplayModel } from "@/lib/meeting/focus-display";
import { formatChineseThinkingText } from "@/lib/meeting/meeting-display-text";
import { MeetingMarkdownText } from "./meeting-markdown-text";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const statusLabel = {
  idle: "Ready",
  starting: "Starting",
  reconnecting: "Audio reconnecting",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  paused: "Paused",
  error: "Needs attention",
};

const responseLengthOptions: Array<{
  id: MeetingResponseLength;
  label: string;
}> = [
  { id: "short", label: "Short" },
  { id: "normal", label: "Normal" },
  { id: "detailed", label: "Detailed" },
];

const responseLanguageOptions: Array<{
  id: MeetingResponseLanguage;
  label: string;
}> = [
  { id: "auto", label: "Auto" },
  { id: "english", label: "English" },
  { id: "chinese", label: "Chinese" },
];

const meetingAudioProfileOptions: Array<{
  id: Exclude<MeetingAudioProfile, "custom">;
  label: string;
}> = [
  { id: "quiet", label: "Quiet" },
  { id: "balanced", label: "Balanced" },
  { id: "sensitive", label: "Sensitive" },
];

const responseActionOptions: Array<{
  id: MeetingResponseActionMode;
  label: string;
  title: string;
}> = [
  {
    id: "narrow-context",
    label: "Narrow",
    title: "Regenerate from only the current source-owned question",
  },
  {
    id: "enhance-context",
    label: "Enhance",
    title: "Add the smallest useful source context around the current question",
  },
  {
    id: "previous-phase",
    label: "Back",
    title: "Return this parent task to its previous committed playbook phase",
  },
  {
    id: "next-phase",
    label: "Next",
    title: "Advance the current task to the next useful playbook phase",
  },
];

const humanEvalQuestionTypeOptions: Array<{
  id: HumanEvalQuestionType;
  label: string;
}> = [
  { id: "behavioral", label: "Behavioral" },
  { id: "coding", label: "Coding" },
  { id: "ai-ml-system-design", label: "AI/ML design" },
  { id: "general-system-design", label: "System design" },
  { id: "project-deep-dive", label: "Project dive" },
  { id: "field-knowledge", label: "Field knowledge" },
  { id: "unknown", label: "Unknown" },
];


const humanEvalFailureReasonOptions: Array<{
  id: HumanEvalFailureReason;
  label: string;
}> = [
  { id: "wrong-question-type", label: "Type" },
  { id: "wrong-playbook", label: "Playbook" },
  { id: "wrong-playbook-phase", label: "Phase" },
  { id: "wrong-company", label: "Company" },
  { id: "wrong-memory", label: "Wrong memory" },
  { id: "missing-memory", label: "Missing memory" },
  { id: "wrong-answer", label: "Answer" },
  { id: "too-short", label: "Too short" },
  { id: "too-slow", label: "Too slow" },
  { id: "incorrect-visible-refresh", label: "Wrong refresh" },
  { id: "mid-read-interruption", label: "Mid-read" },
  { id: "stt-error", label: "STT" },
  { id: "capture-error", label: "Capture" },
  { id: "other", label: "Other" },
];

const criticalMomentFailureReasonOptions: Array<{
  id: CriticalMomentFailureReason;
  label: string;
}> = [
  { id: "no-advice", label: "No advice" },
  { id: "late-advice", label: "Late" },
  { id: "wrong-question", label: "Question" },
  { id: "wrong-type", label: "Type" },
  { id: "wrong-relation", label: "Relation" },
  { id: "wrong-context", label: "Context" },
  { id: "unsupported-fact", label: "Fact" },
  { id: "irrelevant-memory", label: "Memory" },
  { id: "insufficient-answer", label: "Insufficient" },
  { id: "provider-or-parser-failure", label: "Provider" },
  { id: "stale-or-cancelled", label: "Stale" },
  { id: "ui-or-interaction-friction", label: "UI friction" },
  { id: "user-did-not-need-help", label: "Not needed" },
  { id: "other", label: "Other" },
];


const memoryEntryLabelOptions: Array<{
  id: MemoryEntryEvaluationLabelValue;
  label: string;
}> = [
  { id: "relevant", label: "Relevant" },
  { id: "irrelevant", label: "Irrelevant" },
  { id: "forbidden", label: "Forbidden" },
];


const HOTKEY_CAPTURE_SETTLE_MS = 180;
const HOTKEY_CAPTURE_DEBOUNCE_MS = 250;
const MEETING_PANEL_WIDTH = 920;
const PANEL_WIDTH_CLASS = "w-[920px] max-w-[100vw]";
const WRAP_TEXT_CLASS =
  "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
const CHINESE_THINKING_TEXT_CLASS =
  "min-w-0 break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere] [&_*]:leading-5 [&_li]:my-0 [&_ol]:my-0 [&_p]:my-0 [&_p+p]:mt-1 [&_ul]:my-0";
const TASK_TIMEOUT_OPTIONS = [15, 30, 60, 120] as const;
const FOCUS_MODE_SHORTCUT_LABEL = "Cmd+Shift+J";
const FOCUS_LISTENING_SHORTCUT_LABEL = "Cmd+Shift+L";
const FOCUS_REGENERATE_SHORTCUT_LABEL = "Cmd+Shift+U";
const FOCUS_ENHANCE_CONTEXT_SHORTCUT_LABEL = "Cmd+Shift+Up";
const FOCUS_NARROW_CONTEXT_SHORTCUT_LABEL = "Cmd+Shift+Down";
const FOCUS_PREVIOUS_PHASE_SHORTCUT_LABEL = "Cmd+Shift+Left";
const FOCUS_NEXT_PHASE_SHORTCUT_LABEL = "Cmd+Shift+Right";

const EMPTY_INTERVIEW_SESSION_BRIEF: InterviewSessionBrief = {
  targetCompany: "",
  targetCompanyNormalized: undefined,
  companyLocked: false,
  interviewTypes: [],
};

const interviewBriefTypeOptions: Array<{
  id: InterviewBriefType;
  label: string;
  shortLabel: string;
}> = [
  { id: "behavioral", label: "Behavioral", shortLabel: "Behavioral" },
  { id: "coding", label: "Coding", shortLabel: "Coding" },
  { id: "system-design", label: "General system design", shortLabel: "Gen SD" },
  { id: "ai-ml-system-design", label: "AI/ML system design", shortLabel: "AI/ML SD" },
  { id: "project-deep-dive", label: "Project deep-dive", shortLabel: "Project" },
];

const concreteInterviewBriefTypes = interviewBriefTypeOptions
  .map((option) => option.id)
  .filter((type): type is Exclude<InterviewBriefType, "mixed"> => type !== "mixed");

const currentQuestionTypeOptions: Array<{
  id: CanonicalQuestionType;
  label: string;
  shortLabel: string;
}> = [
  ...interviewBriefTypeOptions.flatMap((option) => {
    const canonicalType = normalizeCanonicalQuestionType(option.id);
    return canonicalType
      ? [{ ...option, id: canonicalType }]
      : [];
  }),
  {
    id: "field-knowledge",
    label: "Field knowledge",
    shortLabel: "Field",
  },
];

function toggleInterviewBriefType(
  currentTypes: InterviewBriefType[],
  type: InterviewBriefType,
  forceSingleConcrete = false
): InterviewBriefType[] {
  const current = new Set(currentTypes);

  if (forceSingleConcrete) {
    return [type];
  }

  if (current.has(type)) {
    current.delete(type);
  } else {
    current.add(type);
  }

  const concreteTypes = concreteInterviewBriefTypes.filter((candidate) =>
    current.has(candidate)
  );
  return concreteTypes;
}

function waitForHotkeyCaptureSettle() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, HOTKEY_CAPTURE_SETTLE_MS);
  });
}

type MeetingAssistantProps = {
  onFocusModeActiveChange?: (active: boolean) => void;
};

type ClarifyingSelectionState = {
  questionKey: string;
  label: string;
  value?: string;
  submittedAt: number;
  status: ClarifyingSelectionLifecycleState;
  requestId?: string;
  traceId?: string;
  reason?: string;
};

type NativeAudioFaultFeedback = {
  inFlightKind?: NativeAudioDebugFaultKind;
  status: "idle" | "success" | "error";
  message?: string;
};

export const MeetingAssistant = ({
  onFocusModeActiveChange,
}: MeetingAssistantProps = {}) => {
  const meeting = useMeetingAssistant();
  const { resizeWindow } = useWindowResize();
  const [open, setOpen] = useState(false);
  const [configurationsOpen, setConfigurationsOpen] = useState(false);
  const [interviewBriefOpen, setInterviewBriefOpen] = useState(false);
  const [dismissedQuestionKey, setDismissedQuestionKey] = useState<
    string | null
  >(null);
  const [clarifyingSelection, setClarifyingSelection] =
    useState<ClarifyingSelectionState | null>(null);
  const [isFocusMode, setIsFocusMode] = useState(
    () => safeLocalStorage.getItem(STORAGE_KEYS.MEETING_FOCUS_MODE) === "true"
  );
  const [focusWindowsVisible, setFocusWindowsVisible] = useState(false);
  const [speechCorrectionInput, setSpeechCorrectionInput] = useState("");
  const [nativeAudioFaultFeedback, setNativeAudioFaultFeedback] =
    useState<NativeAudioFaultFeedback>({ status: "idle" });
  const [codingArtifactCache, setCodingArtifactCache] =
    useState<CodingArtifactCache | null>(null);
  const presentationArtifactResetRevisionRef = useRef(
    meeting.presentationArtifactResetRevision
  );
  const screenHotkeyRequestRevisionRef = useRef(0);
  const lastScreenHotkeyAtRef = useRef(0);

  const latestTurn = [...meeting.transcriptTurns]
    .reverse()
    .find(
      (turn) =>
        turn.speaker !== "me" &&
        turn.contextFusionStatus !== "duplicate-suppressed"
    );
  const latestInterviewerTurnText =
    meeting.displayTranscriptWindow?.current?.text ??
    meeting.latestDisplayTranscript?.text ??
    latestTurn?.text ??
    "Waiting for meeting audio.";
  const transcriptHistory =
    meeting.displayTranscriptWindow?.history ?? [];
  const forceAdviseStatus = meeting.latestInterviewerTurnCandidate?.status;
  const forceAdviseEligibility = decideForceAdviseEligibility(
    meeting.latestInterviewerTurnCandidate
  );
  const forceAdviseAvailable = forceAdviseEligibility.eligible;
  const forceAdvisePending =
    meeting.latestInterviewerTurnCandidate?.manualExecutionState ===
      "running" || forceAdviseStatus === "repairing";
  const forceAdviseCompleted =
    forceAdviseStatus === "repaired" ||
    forceAdviseStatus === "already-advised";
  const recentMeTurns = meeting.transcriptTurns
    .filter(
      (turn) =>
        turn.speaker === "me" &&
        turn.contextFusionStatus !== "duplicate-suppressed"
    )
    .slice(-4);
  const latestScreenObservation =
    meeting.screenObservations[meeting.screenObservations.length - 1];
  const latestTrace =
    meeting.traces.find(
      (trace) => trace.status === "running" || trace.status === "success"
    ) ?? meeting.traces[0];
  const traceSummary = useMemo(
    () => summarizeMeetingTraces(meeting.traces),
    [meeting.traces]
  );
  const latestCaptureTarget = latestScreenObservation?.captureTarget;
  const displaySuggestion =
    meeting.partialSuggestion || meeting.latestSuggestion?.content || "";
  const completedMeetingAnswer =
    meeting.partialSuggestion || !meeting.latestSuggestion?.meetingAnswer
      ? undefined
      : meeting.latestSuggestion.meetingAnswer;
  const suggestionSections = useMemo(
    () =>
      buildMeetingAnswerDisplayModel({
        content: displaySuggestion,
        parsedAnswer: completedMeetingAnswer,
        expectedProfile: meeting.partialSuggestion
          ? resolveMeetingAnswerProfile(
              getActiveMeetingParentQuestionType(meeting.activeMeetingTask)
            )
          : meeting.latestSuggestion?.answerProfile,
      }),
    [
      completedMeetingAnswer,
      displaySuggestion,
      meeting.activeMeetingTask,
      meeting.latestSuggestion?.answerProfile,
      meeting.partialSuggestion,
    ]
  );
  const hasActiveMeetingTask = Boolean(meeting.activeMeetingTask);
  const hasCorrectableQuestion =
    hasManualQuestionTypeCorrectionPresentationTarget({
      hasActiveTask: hasActiveMeetingTask,
      currentQuestionLineage: meeting.currentQuestionLineage,
      latestSuggestion: meeting.latestSuggestion,
    });
  const hasActiveMeetingScreenContext = Boolean(meeting.activeMeetingTask?.screen);
  const activeParentTaskId =
    getActiveMeetingTaskId(meeting.activeMeetingTask) ?? "";
  const activeTaskKind = getActiveMeetingParentQuestionType(
    meeting.activeMeetingTask
  );
  const activeChildTaskId = meeting.activeMeetingTask?.child?.id;
  const activeChildQuestionType =
    meeting.activeMeetingTask?.child?.questionType;
  const completedSuggestionParentTaskId =
    meeting.latestSuggestion?.parentTaskId ?? meeting.latestSuggestion?.taskId;
  const completedSuggestionChildTaskId =
    meeting.latestSuggestion?.childTaskId;
  const completedSuggestionQuestionType =
    meeting.latestSuggestion?.questionType;
  const displayedSuggestionParentTaskId = meeting.partialSuggestion
    ? activeParentTaskId
    : completedSuggestionParentTaskId;
  const displayedSuggestionChildTaskId = meeting.partialSuggestion
    ? activeChildTaskId
    : completedSuggestionChildTaskId;
  const displayedSuggestionQuestionType = meeting.partialSuggestion
    ? activeChildQuestionType ?? activeTaskKind
    : completedSuggestionQuestionType;
  useEffect(() => {
    if (meeting.partialSuggestion) return;

    setCodingArtifactCache((previous) => {
      return updateCodingArtifactCache({
        activeParentTaskId,
        activeParentQuestionType: activeTaskKind,
        activeChildTaskId,
        activeChildQuestionType,
        cache: previous,
        sections: suggestionSections,
        sourceParentTaskId: completedSuggestionParentTaskId,
        sourceChildTaskId: completedSuggestionChildTaskId,
        sourceQuestionType: completedSuggestionQuestionType,
        sourceCodeMutationAuthorized:
          meeting.latestSuggestion?.codeArtifactMutationAuthorized,
        sourceComplexityMutationAuthorized:
          meeting.latestSuggestion?.complexityArtifactMutationAuthorized,
        sourcePresentationArtifactAuthority:
          meeting.latestSuggestion?.presentationArtifactAuthority,
        sourceCodeRevision:
          meeting.latestSuggestion?.codeArtifactRevision,
        sourceComplexityRevision:
          meeting.latestSuggestion?.complexityArtifactRevision,
        sourceSuggestionId: meeting.latestSuggestion?.id,
        updatedAt: Date.now(),
      });
    });
  }, [
    activeParentTaskId,
    activeTaskKind,
    activeChildTaskId,
    activeChildQuestionType,
    completedSuggestionChildTaskId,
    completedSuggestionParentTaskId,
    completedSuggestionQuestionType,
    meeting.latestSuggestion?.codeArtifactMutationAuthorized,
    meeting.latestSuggestion?.complexityArtifactMutationAuthorized,
    meeting.latestSuggestion?.presentationArtifactAuthority,
    meeting.latestSuggestion?.codeArtifactRevision,
    meeting.latestSuggestion?.complexityArtifactRevision,
    meeting.latestSuggestion?.id,
    meeting.partialSuggestion,
    suggestionSections.primaryAnswer,
    suggestionSections.approach,
    suggestionSections.code,
    suggestionSections.complexity,
    suggestionSections.focusedQuestion,
  ]);
  useEffect(() => {
    if (
      presentationArtifactResetRevisionRef.current ===
      meeting.presentationArtifactResetRevision
    ) {
      return;
    }
    presentationArtifactResetRevisionRef.current =
      meeting.presentationArtifactResetRevision;
    setCodingArtifactCache(null);
  }, [meeting.presentationArtifactResetRevision]);
  const codingArtifactDisplay = useMemo(() => {
    return resolveCodingArtifactDisplay({
      activeParentTaskId,
      activeParentQuestionType: activeTaskKind,
      activeChildTaskId,
      activeChildQuestionType,
      cache: codingArtifactCache,
      sections: suggestionSections,
      sourceParentTaskId: displayedSuggestionParentTaskId,
      sourceChildTaskId: displayedSuggestionChildTaskId,
      sourceQuestionType: displayedSuggestionQuestionType,
      sourcePresentationArtifactAuthority:
        meeting.partialSuggestion
          ? undefined
          : meeting.latestSuggestion?.presentationArtifactAuthority,
    });
  }, [
    activeParentTaskId,
    activeTaskKind,
    activeChildTaskId,
    activeChildQuestionType,
    codingArtifactCache,
    displayedSuggestionChildTaskId,
    displayedSuggestionParentTaskId,
    displayedSuggestionQuestionType,
    meeting.latestSuggestion?.presentationArtifactAuthority,
    suggestionSections.primaryAnswer,
    suggestionSections.approach,
    suggestionSections.code,
    suggestionSections.complexity,
    suggestionSections.focusedQuestion,
  ]);
  const whiteboardArtifactDisplay = useMemo(() => {
    return resolveWhiteboardArtifactDisplay({
      activeParentTaskId,
      activeParentQuestionType: activeTaskKind,
      artifact: meeting.activeMeetingTask?.parent.whiteboardArtifact,
      sourceParentTaskId: activeParentTaskId,
      sourceParentQuestionType: activeTaskKind,
    });
  }, [
    activeParentTaskId,
    activeTaskKind,
    meeting.activeMeetingTask?.parent.whiteboardArtifact,
  ]);
  const runtimeSuggestionSections = useMemo(
    () => overlayMeetingAnswerArtifacts(suggestionSections, {
      whiteboard: whiteboardArtifactDisplay.whiteboard,
      code: codingArtifactDisplay.code,
      complexity: codingArtifactDisplay.complexity,
    }),
    [
      codingArtifactDisplay.code,
      codingArtifactDisplay.complexity,
      suggestionSections,
      whiteboardArtifactDisplay.whiteboard,
    ]
  );
  const adviseDisplay = meeting.selectAdviseDisplay(runtimeSuggestionSections);
  const displaySuggestionSections = adviseDisplay.sections;
  const displayTargetKey = JSON.stringify(adviseDisplay.target);
  const artifactReuseNotice = meeting.traces.find(trace => trace.id === adviseDisplay.target.traceId)?.metadata?.artifactReuseCommitted === true
    ? "Artifacts reused" : undefined;
  useEffect(() => {
    if (!open || (isFocusMode && focusWindowsVisible)) return;
    meeting.recordAdviseDisplayApplied(adviseDisplay.target, isFocusMode ? "focus-mode" : "normal-mode");
  }, [displayTargetKey, adviseDisplay.locked, open, isFocusMode, focusWindowsVisible, meeting.recordAdviseDisplayApplied]);
  const factGuardrailNotice =
    (adviseDisplay.locked ? adviseDisplay.stable?.suggestion : meeting.latestSuggestion)?.factGuardrailNotice;
  const latestReliableAnswerPreview = useMemo(
    () =>
      formatLatestReliableAnswerPreview(
        meeting.latestReliableSuggestion,
        displaySuggestion
      ),
    [displaySuggestion, meeting.latestReliableSuggestion]
  );
  const currentEvaluationTarget = useMemo(
    () =>
      resolveSettledAttemptEvaluationTarget({
        suggestion: meeting.latestSuggestion,
        answerInProgress:
          meeting.status === "thinking" &&
          Boolean(meeting.partialSuggestion.trim()),
        traces: meeting.traces,
        currentSessionId: meeting.meetingSessionId,
        pinnedDisplay: adviseDisplay.locked ? {
          suggestion: adviseDisplay.stable?.suggestion ?? null,
          streaming: adviseDisplay.streaming, traceId: adviseDisplay.target.traceId,
        } : undefined,
      }),
    [
      meeting.latestSuggestion,
      meeting.partialSuggestion,
      meeting.meetingSessionId,
      meeting.status,
      meeting.traces,
      displayTargetKey,
      adviseDisplay.locked,
      adviseDisplay.streaming,
    ]
  );
  const [frozenEvaluationTarget, setFrozenEvaluationTarget] = useState<typeof currentEvaluationTarget>();
  useEffect(() => { setFrozenEvaluationTarget(undefined); }, [meeting.meetingSessionId]);
  const evaluationTarget = frozenEvaluationTarget ?? currentEvaluationTarget;
  const evaluationTrace = evaluationTarget.traceId
    ? meeting.traces.find((trace) => trace.id === evaluationTarget.traceId)
    : undefined;
  const evaluationSessionId = typeof evaluationTrace?.metadata?.effectiveCurrentQuestionSettlementSessionId === "string"
    ? evaluationTrace.metadata.effectiveCurrentQuestionSettlementSessionId : meeting.meetingSessionId;
  useEffect(() => { void meeting.loadHumanEvaluationSession(evaluationSessionId); }, [evaluationSessionId, meeting.loadHumanEvaluationSession]);
  const answerQuestionEvaluation = evaluationTrace
    ? findQuestionHumanEvaluationForTrace(
        meeting.questionEvaluations,
        evaluationTrace.id
      )
    : undefined;
  const answerEvaluationProjectionV2 = evaluationTrace
    ? meeting.humanEvaluationProjectionsV2.find(
        (projection) =>
          projection.subject.attemptId === evaluationTrace.id
      ) ??
      meeting.humanEvaluationProjectionsV2.find(
        (projection) =>
          !projection.subject.attemptId &&
          projection.observed?.traceId === evaluationTrace.id
      )
    : undefined;
  const evaluationTaskId =
    answerEvaluationProjectionV2?.subject.taskId ??
    (typeof evaluationTrace?.metadata?.activeMeetingTaskId === "string"
      ? evaluationTrace.metadata.activeMeetingTaskId
      : typeof evaluationTrace?.metadata?.taskId === "string"
        ? evaluationTrace.metadata.taskId
        : undefined);
  const evaluationQuestionSummary =
    answerEvaluationProjectionV2?.observed?.primaryAsk ??
    (typeof evaluationTrace?.metadata?.currentQuestionPreview === "string"
      ? evaluationTrace.metadata.currentQuestionPreview
      : typeof evaluationTrace?.metadata?.primaryAskNormalizedText === "string"
        ? evaluationTrace.metadata.primaryAskNormalizedText
        : undefined);
  const answerMemoryEvaluationSnapshot =
    resolveTraceMemoryEvaluationSnapshot(evaluationTrace);
  const answerPreparationArtifactUses = useMemo(() => {
    if (!evaluationTrace) return [];
    return selectPreparationArtifactUseReceiptsForEvaluation({
      receipts: meeting.preparationArtifactUses,
      traceId: evaluationTrace.id,
      questionId: answerQuestionEvaluation?.questionId,
      answerRevision:
        typeof evaluationTrace.metadata?.visibleAnswerRevisionAfter ===
        "number"
          ? evaluationTrace.metadata.visibleAnswerRevisionAfter
          : undefined,
    });
  }, [
    answerQuestionEvaluation?.questionId,
    evaluationTrace,
    meeting.preparationArtifactUses,
  ]);
  const currentTranscriptTurnIds = useMemo(
    () => new Set(meeting.transcriptTurns.map((turn) => turn.id)),
    [meeting.transcriptTurns]
  );
  const latestCriticalMomentCandidate = useMemo(
    () =>
      [...meeting.criticalMomentCandidates]
        .filter((candidate) =>
          candidate.sourceTurnIds.some((turnId) =>
            currentTranscriptTurnIds.has(turnId)
          )
        )
        .sort(
          (left, right) =>
            (right.opportunityEndAt ?? right.updatedAt) -
            (left.opportunityEndAt ?? left.updatedAt)
        )[0],
    [currentTranscriptTurnIds, meeting.criticalMomentCandidates]
  );
  const latestCriticalMomentEvaluation = latestCriticalMomentCandidate
    ? meeting.criticalMomentEvaluations.find(
        (evaluation) =>
          evaluation.momentId === latestCriticalMomentCandidate.momentId
      )
    : undefined;
  const latestCriticalMomentGroundTruth = useMemo(
    () =>
      latestCriticalMomentCandidate
        ? resolveCriticalMomentExpectedFacts({
            candidate: latestCriticalMomentCandidate,
            projections: meeting.humanEvaluationProjectionsV2,
            legacyEvaluation: latestCriticalMomentEvaluation,
          })
        : undefined,
    [
      latestCriticalMomentCandidate,
      latestCriticalMomentEvaluation,
      meeting.humanEvaluationProjectionsV2,
    ]
  );
  const latestCriticalMomentTraces = latestCriticalMomentCandidate
    ? latestCriticalMomentCandidate.proposedTraceIds
        .map((traceId) =>
          meeting.traces.find((trace) => trace.id === traceId)
        )
        .filter((trace): trace is MeetingTrace => Boolean(trace))
    : [];
  const clarifyingQuestion = displaySuggestionSections.clarifyingQuestion.trim();
  const rawClarifyingOptions = displaySuggestionSections.clarifyingOptions ?? [];
  const displayedSuggestion = adviseDisplay.stable?.suggestion;
  const clarifyingSourceTrace = displayedSuggestion?.sourceTraceId
    ? meeting.traces.find(
        (trace) => trace.id === displayedSuggestion?.sourceTraceId
      )
    : undefined;
  const projectBindingClarifyingCandidates = useMemo(
    () =>
      readProjectBindingClarifyingCandidates(
        clarifyingSourceTrace?.metadata
      ),
    [clarifyingSourceTrace?.metadata]
  );
  const clarifyingQuestionOwner =
    displayedSuggestion?.questionLineage?.questionInstanceId ??
    displayedSuggestion?.parentTaskId ??
    displayedSuggestion?.id ??
    adviseDisplay.target.generationId;
  const clarifyingQuestionKey = clarifyingQuestion
    ? `${clarifyingQuestionOwner}:${clarifyingQuestion}`
    : "";
  const clarifyingOptionDisplay = useMemo(
    () =>
      buildClarifyingOptionDisplayModel({
        question: clarifyingQuestion,
        options: rawClarifyingOptions,
        projectBindingNeedsSelection:
          projectBindingClarifyingCandidates.needsSelection,
        projectBindingCandidates:
          projectBindingClarifyingCandidates.candidates,
      }),
    [
      clarifyingQuestion,
      projectBindingClarifyingCandidates,
      rawClarifyingOptions,
    ]
  );
  const clarifyingOptions = clarifyingOptionDisplay.options;
  const activeClarifyingSelection =
    clarifyingSelection?.questionKey === clarifyingQuestionKey
      ? clarifyingSelection
      : null;
  const showClarifyingQuestion = Boolean(
    clarifyingQuestion && dismissedQuestionKey !== clarifyingQuestionKey
  );
  const isTaskSwitchClarifyingQuestion =
    isTaskSwitchQuestion(clarifyingQuestion);
  useEffect(() => {
    if (!clarifyingSelection) return;
    if (clarifyingSelection.questionKey === clarifyingQuestionKey) return;
    setClarifyingSelection(null);
  }, [clarifyingQuestionKey, clarifyingSelection]);
  useEffect(() => {
    if (!activeClarifyingSelection?.traceId) return;
    const trace = meeting.traces.find(
      (candidate) => candidate.id === activeClarifyingSelection.traceId
    );
    const recordedState = trace?.metadata?.clarifyingSelectionState;
    if (
      recordedState !== "pending" &&
      recordedState !== "succeeded" &&
      recordedState !== "failed" &&
      recordedState !== "stale"
    ) {
      return;
    }
    const reason =
      typeof trace?.metadata?.clarifyingSelectionTerminalReason === "string"
        ? trace.metadata.clarifyingSelectionTerminalReason
        : activeClarifyingSelection.reason;
    if (
      activeClarifyingSelection.status === recordedState &&
      activeClarifyingSelection.reason === reason
    ) {
      return;
    }
    setClarifyingSelection((current) =>
      current?.questionKey === clarifyingQuestionKey
        ? { ...current, status: recordedState, reason }
        : current
    );
  }, [
    activeClarifyingSelection,
    clarifyingQuestionKey,
    meeting.traces,
  ]);
  const isBusy =
    meeting.status === "starting" ||
    meeting.status === "reconnecting" ||
    meeting.status === "transcribing" ||
    meeting.status === "thinking";
  const isListening = meeting.status === "listening";
  const isPaused = meeting.status === "paused";
  const isRunning =
    meeting.status === "listening" ||
    meeting.status === "transcribing" ||
    meeting.status === "thinking";
  const manualAudioRecoveryPending = Boolean(
    meeting.nativeAudioManualRecovery
  );
  const manualAudioRecoveryRequired =
    meeting.status === "error" && manualAudioRecoveryPending;
  const primaryAudioAction = resolveNativeAudioPrimaryControlAction({
    status: meeting.status,
    manualRecoveryRequired: manualAudioRecoveryRequired,
  });
  const audioPauseResumeControl = useMemo(
    () =>
      resolveNativeAudioPauseResumeControl({
        status: meeting.status,
        manualRecoveryPending: manualAudioRecoveryPending,
      }),
    [manualAudioRecoveryPending, meeting.status]
  );
  const primaryAudioActionLabel =
    primaryAudioAction === "stop"
      ? "Stop"
      : primaryAudioAction === "start"
        ? "Start"
        : "Resume";
  const meetingStatusLabel = manualAudioRecoveryRequired
    ? "Resume audio"
    : statusLabel[meeting.status];
  const hasMeetingContext =
    meeting.transcriptTurns.length > 0 || meeting.screenObservations.length > 0;
  const hasSuggestion = Boolean(displaySuggestionSections.primaryAnswer.trim());
  const focusModeActive = open && isFocusMode;
  const editableBriefForFocus = useMemo(
    () => getEditableInterviewSessionBrief(meeting.interviewSessionBrief),
    [meeting.interviewSessionBrief]
  );
  const currentQuestionTrace = meeting.latestSuggestion?.sourceTraceId
    ? meeting.traces.find(
        (trace) => trace.id === meeting.latestSuggestion?.sourceTraceId
      )
    : undefined;
  const currentQuestionTypeObservation = projectQuestionTypeObservation({
    metadata: currentQuestionTrace?.metadata,
    fallbackCurrentQuestionType:
      meeting.latestSuggestion?.questionType ??
      meeting.activeMeetingTask?.child?.questionType ??
      activeTaskKind,
    fallbackParentType: activeTaskKind,
    fallbackParentId: meeting.activeMeetingTask?.parent.id,
  });
  const effectiveQuestionType =
    currentQuestionTypeObservation.observedCurrentQuestionType ??
    (hasCorrectableQuestion ? "unknown" : undefined);
  const transientPersonalStatusLabel =
    meeting.latestSuggestion?.transientPersonalStatus?.label;
  const activeManualQuestionTypeCorrection =
    meeting.manualQuestionTypeCorrection &&
    (meeting.manualQuestionTypeCorrection.taskId ===
      meeting.activeMeetingTask?.id ||
      meeting.manualQuestionTypeCorrection.questionId ===
        meeting.currentQuestionLineage?.questionInstanceId)
      ? meeting.manualQuestionTypeCorrection
      : undefined;
  const audioWarningLabel = meeting.audioInputLiveness?.severity === "warning"
    ? meeting.audioInputLiveness.label : undefined;
  const audioWarningDetail = audioWarningLabel ? meeting.audioInputLiveness?.detail : undefined;
  const focusSnapshot = useMemo<MeetingFocusSnapshot>(
    () => createMeetingFocusDisplayModel({
      active: focusModeActive,
      advisePin: { locked: adviseDisplay.locked, backgroundUpdated: adviseDisplay.backgroundUpdated,
        target: adviseDisplay.target },
      sections: {
        chineseThinking: displaySuggestionSections.chineseThinking,
        primaryAnswer: displaySuggestionSections.primaryAnswer,
        focusedQuestion: displaySuggestionSections.focusedQuestion,
        approach: displaySuggestionSections.approach,
        whiteboard: displaySuggestionSections.whiteboard,
        whiteboardViewKey: adviseDisplay.locked ? `${adviseDisplay.target.suggestionId ?? adviseDisplay.target.generationId}:${adviseDisplay.stable?.sections.whiteboard.revision ?? 0}` : whiteboardArtifactDisplay.viewKey,
        code: displaySuggestionSections.code,
        complexity: displaySuggestionSections.complexity,
        clarifyingQuestion: displaySuggestionSections.clarifyingQuestion,
        clarifyingOptions: clarifyingOptions,
        profile: displaySuggestionSections.profile,
        hasTechnicalDetails: displaySuggestionSections.hasTechnicalDetails,
      },
      latestReliableAnswer: adviseDisplay.locked ? "" : latestReliableAnswerPreview,
      latestTurnText: latestInterviewerTurnText,
      forceAdviseAvailable,
      forceAdvisePending,
      forceAdviseCompleted,
      answerDelivery: meeting.answerDelivery,
      statusLabel: meetingStatusLabel,
      error: meeting.error,
      factGuardrailNotice,
      phaseOutputNotice: adviseDisplay.locked ? undefined : meeting.phaseOutputNotice,
      artifactReuseNotice,
      isBusy,
      audioControl: audioPauseResumeControl,
      audioInputWarning: audioWarningLabel && audioWarningDetail
        ? { label: audioWarningLabel, detail: audioWarningDetail }
        : undefined,
      showClarifyingQuestion,
      clarifyingQuestion,
      showClarifyingBooleanFallback:
        clarifyingOptionDisplay.showBooleanFallback,
      selectedClarifyingAnswerLabel: activeClarifyingSelection?.label,
      clarifyingSelectionState: activeClarifyingSelection?.status,
      clarifyingSelectionMessage: formatClarifyingSelectionMessage(
        activeClarifyingSelection
      ),
      isTaskSwitchClarifyingQuestion,
      interviewTypes: editableBriefForFocus.interviewTypes,
      effectiveQuestionType,
      currentQuestionTypeAuthority:
        currentQuestionTypeObservation.observedCurrentQuestionTypeAuthority,
      parentQuestionType:
        currentQuestionTypeObservation.observedParentType,
      parentTaskId: currentQuestionTypeObservation.observedParentId,
      typeAppliedToResponse:
        currentQuestionTypeObservation.typeAppliedToResponse,
      typeAppliedToSettlement:
        currentQuestionTypeObservation.typeAppliedToSettlement,
      typeAppliedToParent:
        currentQuestionTypeObservation.typeAppliedToParent,
      durableOwnerMissing:
        currentQuestionTypeObservation.durableOwnerMissing,
      durableOwnerMissingReason:
        currentQuestionTypeObservation.durableOwnerMissingReason,
      transientPersonalStatusLabel,
      currentQuestionId: meeting.currentQuestionLineage?.questionInstanceId,
      questionTypeCorrected:
        Boolean(activeManualQuestionTypeCorrection) ||
        meeting.taskRuntime.screenAttachment?.classifier?.overrideSource ===
          "interview-type-selector",
      manualQuestionTypeCorrection: activeManualQuestionTypeCorrection,
      activeTask: getActiveMeetingTaskFocusSummary(meeting.activeMeetingTask),
      hasActiveMeetingTask,
      hasCorrectableQuestion,
      hasActiveScreenTask: hasActiveMeetingScreenContext,
      speechCorrections: meeting.speechCorrections.slice(-4).map((item) => ({
        id: item.id,
        input: item.input,
        from: item.from,
        to: item.to,
        term: item.term,
        appliedCount: item.appliedCount,
        deactivatedAt: item.deactivatedAt,
        activeQuestion: item.activeQuestion,
      })),
    }),
    [
      displayTargetKey,
      adviseDisplay.locked,
      adviseDisplay.backgroundUpdated,
      artifactReuseNotice,
      clarifyingQuestion,
      clarifyingOptionDisplay.showBooleanFallback,
      activeClarifyingSelection?.label,
      activeClarifyingSelection?.status,
      activeClarifyingSelection?.reason,
      editableBriefForFocus.interviewTypes,
      focusModeActive,
      factGuardrailNotice,
      meeting.phaseOutputNotice,
      isBusy,
      isTaskSwitchClarifyingQuestion,
      latestReliableAnswerPreview,
      latestInterviewerTurnText,
      forceAdviseAvailable,
      forceAdvisePending,
      forceAdviseCompleted,
      meeting.answerDelivery,
      meeting.activeMeetingTask,
      meeting.currentQuestionLineage,
      currentQuestionTrace,
      activeTaskKind,
      activeManualQuestionTypeCorrection,
      effectiveQuestionType,
      transientPersonalStatusLabel,
      meeting.taskRuntime.screenAttachment?.classifier?.overrideSource,
      hasActiveMeetingTask,
      hasCorrectableQuestion,
      hasActiveMeetingScreenContext,
      meeting.error,
      meeting.nativeAudioManualRecovery,
      audioWarningLabel,
      audioWarningDetail,
      meeting.speechCorrections,
      meeting.status,
      meetingStatusLabel,
      audioPauseResumeControl,
      showClarifyingQuestion,
      displaySuggestionSections.primaryAnswer,
      displaySuggestionSections.chineseThinking,
      clarifyingOptions,
      displaySuggestionSections.code,
      displaySuggestionSections.complexity,
      displaySuggestionSections.focusedQuestion,
      displaySuggestionSections.approach,
      displaySuggestionSections.clarifyingQuestion,
      displaySuggestionSections.profile,
      displaySuggestionSections.hasTechnicalDetails,
      displaySuggestionSections.whiteboard,
      whiteboardArtifactDisplay.viewKey,
    ]
  );
  const focusPublisherRef = useRef<ReturnType<typeof createMeetingFocusPublisher> | null>(null);
  const focusPublisherReadyRef = useRef<Promise<void> | null>(null);
  const [focusProtocolError, setFocusProtocolError] = useState<string>();
  useEffect(() => {
    const publisher = createMeetingFocusPublisher({
      transport: {
        subscribe: (receive) => listen(MEETING_FOCUS_ACTION_EVENT, (message) => receive(message.payload)),
        send: (snapshot) => emit(MEETING_FOCUS_SNAPSHOT_EVENT, snapshot),
      },
      onAction: (action) => focusActionHandlerRef.current(action),
      observe: (observation) => {
        if (observation.event === "applied" && observation.displayTarget) {
          meeting.recordAdviseDisplayApplied(observation.displayTarget, "focus-mode", observation.adviseLocked);
        }
      },
      onError: (error) => setFocusProtocolError(error.message),
    });
    focusPublisherRef.current = publisher;
    focusPublisherReadyRef.current = publisher.start();
    void focusPublisherReadyRef.current.catch(() => undefined);
    return () => {
      publisher.dispose();
      focusPublisherRef.current = null;
      focusPublisherReadyRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (focusModeActive) void focusPublisherRef.current?.publish(focusSnapshot);
  }, [focusModeActive, focusSnapshot]);

  const title = useMemo(() => {
    if (manualAudioRecoveryRequired) {
      return "Resume meeting audio without clearing the current interview context";
    }
    if (meeting.error) {
      return `Meeting assistant needs attention: ${meeting.error}`;
    }

    return "Open meeting assistant";
  }, [manualAudioRecoveryRequired, meeting.error]);

  const captureScreenContextFromHotkey = useCallback(async () => {
    const requestedAt = Date.now();

    if (
      requestedAt - lastScreenHotkeyAtRef.current < HOTKEY_CAPTURE_DEBOUNCE_MS
    ) {
      return;
    }

    const requestRevision = screenHotkeyRequestRevisionRef.current + 1;
    screenHotkeyRequestRevisionRef.current = requestRevision;
    lastScreenHotkeyAtRef.current = requestedAt;

    try {
      if (open) {
        setOpen(false);
        await waitForHotkeyCaptureSettle();
        if (screenHotkeyRequestRevisionRef.current !== requestRevision) return;
        await resizeWindow(false);
        await waitForHotkeyCaptureSettle();
        if (screenHotkeyRequestRevisionRef.current !== requestRevision) return;
      }

      await meeting.captureScreenContext("hotkey", {
        requestedAt,
        onCaptured: () => {
          if (screenHotkeyRequestRevisionRef.current === requestRevision) {
            setOpen(true);
          }
        },
      });
      if (screenHotkeyRequestRevisionRef.current === requestRevision) {
        setOpen(true);
      }
    } finally {
      if (screenHotkeyRequestRevisionRef.current === requestRevision) {
        setOpen(true);
      }
    }
  }, [meeting.captureScreenContext, open, resizeWindow]);

  const setFocusModePreference = useCallback((enabled: boolean) => {
    setIsFocusMode(enabled);
    safeLocalStorage.setItem(
      STORAGE_KEYS.MEETING_FOCUS_MODE,
      enabled ? "true" : "false"
    );
  }, []);

  const toggleFocusMode = useCallback(() => {
    if (!open) {
      setOpen(true);
      setFocusModePreference(true);
      return;
    }

    setFocusModePreference(!isFocusMode);
  }, [isFocusMode, open, setFocusModePreference]);

  useEffect(() => {
    if (focusModeActive && focusWindowsVisible) {
      void resizeWindow(false, { force: true });
      return;
    }

    void resizeWindow(open, open ? { width: MEETING_PANEL_WIDTH } : undefined);
  }, [focusModeActive, focusWindowsVisible, open, resizeWindow]);

  useEffect(() => {
    onFocusModeActiveChange?.(focusModeActive);

    return () => {
      if (focusModeActive) {
        onFocusModeActiveChange?.(false);
      }
    };
  }, [focusModeActive, onFocusModeActiveChange]);

  useEffect(() => {
    let cancelled = false;

    const syncFocusWindows = async () => {
      if (!focusModeActive) {
        setFocusWindowsVisible(false);
        try {
          await invoke("hide_meeting_focus_windows");
        } catch (error) {
          console.error("Failed to hide Focus Mode windows:", error);
        }
        return;
      }

      try {
        await focusPublisherReadyRef.current;
        if (cancelled) return;
        await invoke("show_meeting_focus_windows");
        if (!cancelled) {
          setFocusWindowsVisible(true);
        }
      } catch (error) {
        console.error("Failed to show Focus Mode windows:", error);
        if (!cancelled) {
          setFocusWindowsVisible(false);
        }
      }
    };

    void syncFocusWindows();

    return () => {
      cancelled = true;
    };
  }, [focusModeActive]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupEmergencyHideListener = async () => {
      unlisten = await listen("jarvis-emergency-hide", () => {
        setOpen(false);
        delete document.documentElement.dataset.nativeCursorOverride;
        void resizeWindow(false, { force: true });
      });
    };

    void setupEmergencyHideListener();

    return () => {
      unlisten?.();
    };
  }, [resizeWindow]);

  useEffect(() => {
    const root = document.documentElement;

    if (!open) {
      delete root.dataset.nativeCursorOverride;
      return;
    }

    root.dataset.nativeCursorOverride = "true";

    return () => {
      delete root.dataset.nativeCursorOverride;
    };
  }, [open]);

  const handleToggle = async () => {
    setOpen(true);
    switch (primaryAudioAction) {
      case "manual-recovery":
        await meeting.resumeAfterNativeFailure();
        break;
      case "resume":
        await meeting.resume();
        break;
      case "stop":
        await meeting.stop();
        break;
      case "start":
        await meeting.start();
        break;
    }
  };

  const handlePauseResume = async () => {
    switch (audioPauseResumeControl.action) {
      case "manual-recovery":
        await meeting.resumeAfterNativeFailure();
        return;
      case "resume":
        await meeting.resume();
        return;
      case "pause":
        await meeting.pause();
        return;
      case "unavailable":
        return;
    }
  };

  const handleNativeAudioFaultInjection = useCallback(
    async (faultKind: NativeAudioDebugFaultKind) => {
      setNativeAudioFaultFeedback({ status: "idle", inFlightKind: faultKind });
      try {
        const result = await meeting.injectNativeAudioFault(faultKind);
        setNativeAudioFaultFeedback({
          status: result.disposition === "injected" ? "success" : "error",
          message:
            result.disposition === "injected"
              ? `${faultKind === "recoverable-stream-end" ? "Recoverable" : "Fatal"} fault injected; lifecycle evidence is being recorded.`
              : `Fault not injected: ${result.disposition}.`,
        });
      } catch (error) {
        setNativeAudioFaultFeedback({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [meeting.injectNativeAudioFault]
  );

  const handleFocusListeningShortcut = useCallback(async () => {
    setOpen(true);

    if (
      meeting.status === "starting" ||
      meeting.status === "reconnecting"
    ) {
      return;
    }

    if (primaryAudioAction === "manual-recovery") {
      await meeting.resumeAfterNativeFailure();
      return;
    }

    if (isPaused) {
      await meeting.resume();
      return;
    }

    if (isRunning) {
      await meeting.pause();
      return;
    }

    await meeting.start();
  }, [
    isPaused,
    isRunning,
    primaryAudioAction,
    meeting.pause,
    meeting.resume,
    meeting.resumeAfterNativeFailure,
    meeting.start,
    meeting.status,
  ]);

  const resolveShortcutDisplayTarget = useCallback(() =>
    focusModeActive && focusWindowsVisible
      ? focusPublisherRef.current?.getLatestApplied("answer")?.displayTarget ?? { sessionId: "" }
      : adviseDisplay.target,
  [focusModeActive, focusWindowsVisible, displayTargetKey]);

  const handleRegenerateShortcut = useCallback((
    invocation: GlobalShortcutInvocation
  ) => {
    setOpen(true);
    void meeting.regenerateSuggestion(
      { ...manualShortcutInvocation(invocation), displayTarget: resolveShortcutDisplayTarget() }
    );
  }, [meeting.regenerateSuggestion, resolveShortcutDisplayTarget]);

  const handleNextPhaseShortcut = useCallback((
    invocation: GlobalShortcutInvocation
  ) => {
    setOpen(true);
    void meeting.applyResponseAction(
      "next-phase",
      manualShortcutInvocation(invocation)
    );
  }, [meeting.applyResponseAction]);

  const handleRegenerateArtifactsShortcut = useCallback((
    invocation: GlobalShortcutInvocation
  ) => {
    setOpen(true);
    void meeting.applyResponseAction(
      "regenerate-artifacts",
      { ...manualShortcutInvocation(invocation), displayTarget: resolveShortcutDisplayTarget() }
    );
  }, [meeting.applyResponseAction, resolveShortcutDisplayTarget]);

  const handleScopedResponseActionShortcut = useCallback(
    (
      action: "narrow-context" | "enhance-context" | "previous-phase",
      invocation: GlobalShortcutInvocation
    ) => {
      setOpen(true);
      void meeting.applyResponseAction(
        action,
        { ...manualShortcutInvocation(invocation), displayTarget: resolveShortcutDisplayTarget() }
      );
    },
    [meeting.applyResponseAction, resolveShortcutDisplayTarget]
  );

  const meetingShortcutCallbacks = useMemo(
    () => ({
      meeting_screen_context: (invocation: GlobalShortcutInvocation) => {
        runDispatchedShortcut(invocation, () => {
          void captureScreenContextFromHotkey();
        });
      },
      meeting_focus_mode: (invocation: GlobalShortcutInvocation) => {
        runDispatchedShortcut(invocation, toggleFocusMode);
      },
      meeting_toggle_listening: (invocation: GlobalShortcutInvocation) => {
        runDispatchedShortcut(invocation, () => {
          void handleFocusListeningShortcut();
        });
      },
      meeting_regenerate: handleRegenerateShortcut,
      meeting_toggle_advise_pin: (invocation: GlobalShortcutInvocation) => {
        meeting.toggleAdvisePin({ ...manualShortcutInvocation(invocation), displayTarget: resolveShortcutDisplayTarget(),
          uiSurface: focusModeActive ? "focus-mode" : "normal-mode" });
      },
      meeting_regenerate_artifacts: handleRegenerateArtifactsShortcut,
      meeting_enhance_context: (invocation: GlobalShortcutInvocation) => {
        handleScopedResponseActionShortcut("enhance-context", invocation);
      },
      meeting_narrow_context: (invocation: GlobalShortcutInvocation) => {
        handleScopedResponseActionShortcut("narrow-context", invocation);
      },
      meeting_previous_phase: (invocation: GlobalShortcutInvocation) => {
        handleScopedResponseActionShortcut("previous-phase", invocation);
      },
      meeting_next_phase: handleNextPhaseShortcut,
      meeting_toggle_microphone_context: (
        invocation: GlobalShortcutInvocation
      ) => {
        runDispatchedShortcut(
          invocation,
          meeting.toggleMicrophoneContext
        );
      },
    }),
    [
      captureScreenContextFromHotkey,
      handleFocusListeningShortcut,
      handleNextPhaseShortcut,
      handleRegenerateShortcut,
      handleRegenerateArtifactsShortcut,
      handleScopedResponseActionShortcut,
      meeting.toggleMicrophoneContext,
      meeting.toggleAdvisePin,
      resolveShortcutDisplayTarget,
      focusModeActive,
      displayTargetKey,
      toggleFocusMode,
    ]
  );

  useShortcuts({
    customShortcuts: meetingShortcutCallbacks,
  });

  const handleClarifyingAnswer = useCallback(
    (
      answer: ClarifyingQuestionAnswer,
      option?: { label?: string; value?: string },
      displayTarget = adviseDisplay.target
    ) => {
      if (!clarifyingQuestion) return;

      const label =
        option?.label ||
        (answer === "yes"
          ? "Yes"
          : answer === "no"
            ? "No"
            : answer === "not-sure"
              ? "Not sure"
              : "Selected option");
      const submittedAt = Date.now();
      setClarifyingSelection({
        questionKey: clarifyingQuestionKey,
        label,
        value: option?.value,
        submittedAt,
        status: "pending",
      });
      setDismissedQuestionKey(null);
      void meeting
        .answerClarifyingQuestion(clarifyingQuestion, answer, option, {
          displayTarget,
          questionKey: clarifyingQuestionKey,
          optionSource: clarifyingOptionDisplay.source,
          optionCount: clarifyingOptions.length,
          booleanFallbackUsed:
            clarifyingOptionDisplay.showBooleanFallback &&
            (answer === "yes" || answer === "no"),
        })
        .then((outcome) => {
          setClarifyingSelection((current) =>
            current?.questionKey === clarifyingQuestionKey &&
            current.submittedAt === submittedAt
              ? {
                  ...current,
                  requestId: outcome.requestId,
                  traceId: outcome.traceId,
                  status: outcome.state,
                  reason: outcome.reason,
                }
              : current
          );
        })
        .catch((error) => {
          setClarifyingSelection((current) =>
            current?.questionKey === clarifyingQuestionKey &&
            current.submittedAt === submittedAt
              ? {
                  ...current,
                  status: "failed",
                  reason:
                    error instanceof Error
                      ? error.message
                      : "clarifying-request-failed",
                }
              : current
          );
        });
    },
    [
      clarifyingOptionDisplay.showBooleanFallback,
      clarifyingOptionDisplay.source,
      clarifyingOptions.length,
      clarifyingQuestion,
      clarifyingQuestionKey,
      displayTargetKey,
      meeting.answerClarifyingQuestion,
    ]
  );

  const handleSpeechCorrectionSubmit = useCallback(() => {
    const correction = speechCorrectionInput.trim();
    if (!correction) return;

    setSpeechCorrectionInput("");
    void meeting.submitSpeechCorrection(correction);
  }, [meeting.submitSpeechCorrection, speechCorrectionInput]);
  const handleSpeechCorrectionDeactivate = useCallback(
    (correctionId: string) => {
      void meeting.deactivateSpeechCorrection(correctionId);
    },
    [meeting.deactivateSpeechCorrection]
  );

  const handleNewTaskConfirmation = useCallback(() => {
    if (!clarifyingQuestionKey) return;

    setClarifyingSelection({
      questionKey: clarifyingQuestionKey,
      label: "New task",
      submittedAt: Date.now(),
      status: "succeeded",
      reason: "manual-new-task-confirmed",
    });
    meeting.clearActiveTask();
    setDismissedQuestionKey(clarifyingQuestionKey);
  }, [clarifyingQuestionKey, meeting.clearActiveTask]);

  const handleSameTaskConfirmation = useCallback(() => {
    if (!clarifyingQuestionKey) return;

    setClarifyingSelection({
      questionKey: clarifyingQuestionKey,
      label: "Same task",
      submittedAt: Date.now(),
      status: "succeeded",
      reason: "manual-same-task-confirmed",
    });
    setDismissedQuestionKey(clarifyingQuestionKey);
  }, [clarifyingQuestionKey]);

  const updateFocusInterviewTypes = useCallback(
    (interviewTypes: InterviewBriefType[]) => {
      const nextBrief: InterviewSessionBrief = {
        ...editableBriefForFocus,
        interviewTypes,
        updatedAt: Date.now(),
      };
      meeting.setInterviewSessionBrief(
        isEditableInterviewSessionBriefEmpty(nextBrief) ? undefined : nextBrief,
        "focus-mode"
      );
    },
    [editableBriefForFocus, meeting.setInterviewSessionBrief]
  );

  const focusActionHandlerRef = useRef<(action: MeetingFocusUserAction) => void>(
    () => undefined
  );
  focusActionHandlerRef.current = (action) => {
    switch (action.type) {
      case "toggle-listening":
        void handlePauseResume();
        break;
      case "regenerate":
        void meeting.regenerateSuggestion({ uiSurface: "focus-mode", displayTarget: action.displayTarget ?? { sessionId: "" } });
        break;
      case "toggle-advise-pin":
        meeting.toggleAdvisePin({ uiSurface: "focus-mode", displayTarget: action.displayTarget ?? { sessionId: "" } });
        break;
      case "response-action":
        void meeting.applyResponseAction(action.action, { uiSurface: "focus-mode", displayTarget: action.displayTarget ?? { sessionId: "" } });
        break;
      case "force-advise":
        void meeting.forceAdviseLatestTurn();
        break;
      case "capture-screen":
        void meeting.captureScreenContext();
        break;
      case "submit-correction":
        void meeting.submitSpeechCorrection(action.correction);
        break;
      case "deactivate-correction":
        void meeting.deactivateSpeechCorrection(action.correctionId);
        break;
      case "correct-question-type":
        void meeting.correctActiveQuestionType(
          action.correctedType,
          action.source,
          { actionId: action.actionId, ingressReceivedAt: action.requestedAt, ingressSource: "ui" }
        );
        break;
      case "update-interview-types":
        updateFocusInterviewTypes(action.interviewTypes);
        break;
      case "clarifying-answer":
        handleClarifyingAnswer(action.answer, action.option, action.displayTarget ?? { sessionId: "" });
        break;
      case "new-task":
        handleNewTaskConfirmation();
        break;
      case "same-task":
        handleSameTaskConfirmation();
        break;
      case "dismiss-clarifying-question":
        setDismissedQuestionKey(clarifyingQuestionKey);
        break;
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant={isRunning ? "default" : "outline"}
          title={title}
          className={cn(
            "cursor-pointer",
            meeting.error && "border-red-300 bg-red-50 hover:bg-red-100",
            focusModeActive && "pointer-events-none opacity-0"
          )}
        >
          {isBusy ? (
            <Loader2Icon className="h-4 w-4 animate-spin" />
          ) : isListening ? (
            <RadioIcon className="h-4 w-4" />
          ) : isPaused || primaryAudioAction === "manual-recovery" ? (
            <PlayIcon className="h-4 w-4" />
          ) : (
            <BrainIcon className="h-4 w-4" />
          )}
        </Button>
      </PopoverTrigger>

      {!focusModeActive || !focusWindowsVisible ? (
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={8}
          className={cn(
            PANEL_WIDTH_CLASS,
            "overflow-hidden border-input/50 p-0"
          )}
        >
        <div className="flex h-[calc(100vh-4rem)] w-full max-w-full flex-col overflow-hidden">
          {!isFocusMode ? (
            <div className="flex items-center justify-between gap-2 border-b border-border/50 p-3">
              <div className="flex min-w-0 items-center gap-2">
                <BrainIcon className="h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    Meeting Assistant
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {meetingStatusLabel}
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={cn(
                    "h-6 rounded-md px-2 text-[10px]",
                    isRunning && "border-green-300 text-green-700",
                    meeting.error && "border-red-300 text-red-700"
                  )}
                >
                  {meetingStatusLabel}
                </Badge>
                <Button
                  size="sm"
                  variant={isFocusMode ? "default" : "outline"}
                  className="h-8 px-2 text-[10px]"
                  title={`Toggle Focus Mode (${FOCUS_MODE_SHORTCUT_LABEL})`}
                  onClick={toggleFocusMode}
                >
                  Focus
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  title="Hide panel"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  <EyeOffIcon className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  title="Capture current screen context"
                  onClick={() => {
                    void meeting.captureScreenContext();
                  }}
                  disabled={
                    meeting.status === "starting" ||
                    meeting.status === "reconnecting"
                  }
                >
                  <CameraIcon className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant={
                    audioPauseResumeControl.urgent ? "destructive" : "outline"
                  }
                  className="h-8 w-8"
                  title={audioPauseResumeControl.title}
                  onClick={handlePauseResume}
                  disabled={audioPauseResumeControl.disabled}
                >
                  {audioPauseResumeControl.busy ? (
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                  ) : audioPauseResumeControl.action === "pause" ? (
                    <PauseIcon className="h-4 w-4" />
                  ) : (
                    <PlayIcon className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant={primaryAudioAction === "stop" ? "destructive" : "default"}
                  className="h-8 w-8"
                  title={primaryAudioActionLabel}
                  onClick={handleToggle}
                >
                  {primaryAudioAction === "stop" ? (
                    <SquareIcon className="h-4 w-4" />
                  ) : (
                    <PlayIcon className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {focusProtocolError ? (
            <div role="alert" className="px-3 py-1 text-xs text-destructive">{focusProtocolError}</div>
          ) : null}
          {isFocusMode ? (
              <FocusModePanel
              advisePin={focusSnapshot.advisePin}
              onToggleAdvisePin={() => meeting.toggleAdvisePin({ uiSurface: "focus-mode", displayTarget: adviseDisplay.target })}
              suggestionSections={focusSnapshot.sections}
              codingArtifactCached={codingArtifactDisplay.isCached}
              whiteboardArtifactCached={whiteboardArtifactDisplay.isCached}
              whiteboardViewKey={focusSnapshot.sections.whiteboardViewKey}
              hasCorrectableQuestion={focusSnapshot.hasCorrectableQuestion}
              effectiveQuestionType={focusSnapshot.effectiveQuestionType}
              factGuardrailNotice={focusSnapshot.factGuardrailNotice}
              phaseOutputNotice={focusSnapshot.phaseOutputNotice}
              artifactReuseNotice={focusSnapshot.artifactReuseNotice}
              transientPersonalStatusLabel={
                focusSnapshot.transientPersonalStatusLabel
              }
              answerDeliveryState={focusSnapshot.answerDelivery.state}
              manualQuestionTypeCorrection={
                focusSnapshot.manualQuestionTypeCorrection
              }
              onCorrectQuestionType={(correctedType) => {
                void meeting.correctActiveQuestionType(
                  correctedType,
                  "focus-mode"
                );
              }}
                latestTurnText={focusSnapshot.latestTurnText}
              forceAdviseAvailable={focusSnapshot.forceAdviseAvailable}
              forceAdvisePending={focusSnapshot.forceAdvisePending}
              forceAdviseCompleted={focusSnapshot.forceAdviseCompleted}
              onForceAdvise={() => {
                void meeting.forceAdviseLatestTurn();
              }}
              speechCorrectionInput={speechCorrectionInput}
              onSpeechCorrectionInputChange={setSpeechCorrectionInput}
              onSpeechCorrectionSubmit={handleSpeechCorrectionSubmit}
              onSpeechCorrectionDeactivate={
                handleSpeechCorrectionDeactivate
              }
              speechCorrections={meeting.speechCorrections}
              status={meeting.status}
              error={meeting.error}
              audioInputLiveness={meeting.audioInputLiveness}
              isBusy={focusSnapshot.isBusy}
              audioControl={focusSnapshot.audioControl}
              onToggleAudio={() => {
                void handlePauseResume();
              }}
              showClarifyingQuestion={focusSnapshot.showClarifyingQuestion}
              clarifyingQuestion={focusSnapshot.clarifyingQuestion}
              clarifyingOptions={focusSnapshot.sections.clarifyingOptions}
              showClarifyingBooleanFallback={
                focusSnapshot.showClarifyingBooleanFallback
              }
              selectedClarifyingAnswerLabel={focusSnapshot.selectedClarifyingAnswerLabel}
              clarifyingSelectionState={focusSnapshot.clarifyingSelectionState}
              clarifyingSelectionMessage={focusSnapshot.clarifyingSelectionMessage}
              isTaskSwitchClarifyingQuestion={focusSnapshot.isTaskSwitchClarifyingQuestion}
              onClarifyingAnswer={handleClarifyingAnswer}
              onNewTaskConfirmation={handleNewTaskConfirmation}
              onSameTaskConfirmation={handleSameTaskConfirmation}
              onDismissClarifyingQuestion={() => {
                setDismissedQuestionKey(clarifyingQuestionKey);
              }}
              brief={meeting.interviewSessionBrief}
              onBriefChange={meeting.setInterviewSessionBrief}
            />
          ) : (
            <>
              <ScrollArea className="meeting-assistant-main-scroll min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
            <div className="min-w-0 max-w-full space-y-3 overflow-x-hidden p-3">
              <ConfigurationsPanel
                open={configurationsOpen}
                onOpenChange={setConfigurationsOpen}
                responseConfig={meeting.settings.response}
                onResponseConfigChange={meeting.setResponseConfig}
                codingModel={meeting.settings.codingModel}
                onCodingModelChange={meeting.setCodingModelConfig}
                taxonomyAdjudication={
                  meeting.settings.taxonomyAdjudication
                }
                onTaxonomyAdjudicationChange={
                  meeting.setTaxonomyAdjudicationConfig
                }
                aiProviders={meeting.aiProviders}
                activeScreenTaskTimeoutMinutes={
                  meeting.settings.activeScreenTaskTimeoutMinutes
                }
                onActiveScreenTaskTimeoutMinutesChange={
                  meeting.setActiveScreenTaskTimeoutMinutes
                }
                useMemory={meeting.settings.useMemory}
                onUseMemoryChange={meeting.setUseMemory}
                personalEvidenceGuardrailMode={
                  meeting.settings.personalEvidenceGuardrailMode
                }
                onPersonalEvidenceGuardrailModeChange={
                  meeting.setPersonalEvidenceGuardrailMode
                }
                semanticTaxonomyMode={meeting.settings.semanticTaxonomyMode}
                onSemanticTaxonomyModeChange={meeting.setSemanticTaxonomyMode}
                audioProfile={meeting.settings.audio.profile}
                audioConfig={meeting.settings.audio.config}
                onAudioProfileChange={meeting.setMeetingAudioProfile}
                onAudioConfigChange={meeting.setMeetingAudioConfig}
                microphoneContextEnabled={
                  meeting.settings.microphoneContextEnabled
                }
                onMicrophoneContextEnabledChange={
                  meeting.setMicrophoneContextEnabled
                }
                debugMode={meeting.settings.debugMode}
                onDebugModeChange={meeting.setDebugMode}
                nativeAudioFaultAvailable={Boolean(
                  import.meta.env.DEV &&
                    meeting.settings.debugMode &&
                    meeting.audioStatus?.systemCaptureActive &&
                    meeting.audioStatus.captureOwner === "meeting" &&
                    meeting.audioStatus.captureSessionId &&
                    meeting.audioStatus.captureGeneration != null
                )}
                nativeAudioFaultFeedback={nativeAudioFaultFeedback}
                onNativeAudioFaultInject={handleNativeAudioFaultInjection}
                sessionRecording={meeting.sessionRecording}
                scriptedValidation={meeting.scriptedValidation}
                onSessionRecordingChange={meeting.setSessionRecordingEnabled}
                onSessionRecordingStop={meeting.stopSessionRecording}
                onSessionRecordingAbandon={meeting.abandonSessionRecording}
                onSessionScriptedValidationChange={
                  meeting.setSessionScriptedValidation
                }
                runtimeRegression={meeting.runtimeRegression}
                onStartRuntimeRegressionRun={
                  meeting.startRuntimeRegressionRun
                }
                onStopRuntimeRegressionRun={
                  meeting.stopRuntimeRegressionRun
                }
                onResetRuntimeRegressionRun={
                  meeting.resetRuntimeRegressionRun
                }
                onSubmitRuntimeRegressionText={
                  meeting.submitRuntimeRegressionText
                }
                sttEvaluationCapture={meeting.sttEvaluationCapture}
                sttEvaluationCaptureCanEnable={
                  !meeting.isActive &&
                  (meeting.settings.debugMode ||
                    meeting.sessionRecording.active)
                }
                onSttEvaluationCaptureChange={
                  meeting.setSttEvaluationCaptureEnabled
                }
                onDeleteSttEvaluationCapture={
                  meeting.deleteSttEvaluationCapture
                }
              />

              <InterviewSessionBriefPanel
                open={interviewBriefOpen}
                onOpenChange={setInterviewBriefOpen}
                brief={meeting.interviewSessionBrief}
                onBriefChange={meeting.setInterviewSessionBrief}
                onClear={meeting.clearInterviewSessionBrief}
                preparationRuntime={meeting.preparationRuntime}
                onPreparationRuntimeChange={
                  meeting.setPreparationRuntimeCapabilities
                }
              />

              {meeting.setupWarnings.length > 0 ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="text-xs font-medium text-amber-900">
                    Setup
                  </div>
                  <div className="mt-1 space-y-1">
                    {meeting.setupWarnings.map((warning) => (
                      <div
                        key={warning.code}
                        className={cn(
                          WRAP_TEXT_CLASS,
                          "text-xs",
                          warning.severity === "blocking"
                            ? "text-red-700"
                            : "text-amber-800"
                        )}
                      >
                        {warning.message}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {meeting.error ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-red-200 bg-red-50 p-3">
                  <div className="text-xs font-medium text-red-800">Error</div>
                  <div className={cn(WRAP_TEXT_CLASS, "mt-1 text-xs text-red-700")}>
                    {meeting.error}
                  </div>
                </section>
              ) : null}

              {meeting.audioInputLiveness?.severity === "warning" ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-amber-900">
                    <ActivityIcon className="h-3.5 w-3.5" />
                    {meeting.audioInputLiveness.label}
                  </div>
                  <div
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "mt-1 text-[10px] text-amber-800"
                    )}
                  >
                    {meeting.audioInputLiveness.detail}
                  </div>
                </section>
              ) : null}

              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Latest transcript
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      "ml-auto h-6 gap-1 px-2 text-[10px]",
                      !forceAdviseAvailable && "cursor-not-allowed opacity-50"
                    )}
                    onClick={() => {
                      void meeting.forceAdviseLatestTurn();
                    }}
                    aria-disabled={!forceAdviseAvailable}
                    title={
                      forceAdviseAvailable
                        ? "Force one advisor response for this transcript"
                        : forceAdvisePending
                          ? "Advisor repair is running"
                          : forceAdviseCompleted
                            ? "This transcript has already been advised"
                            : "No recoverable interviewer turn is available"
                    }
                  >
                    {forceAdvisePending ? (
                      <Loader2Icon className="h-3 w-3 animate-spin" />
                    ) : (
                      <BrainIcon className="h-3 w-3" />
                    )}
                    {forceAdvisePending
                      ? "Advising"
                      : forceAdviseCompleted
                        ? "Advised"
                        : "Advise"}
                  </Button>
                </div>
                <p
                  className="sr-only"
                >
                  Interviewer transcript history and latest utterance
                </p>
                <TranscriptLineageWindow
                  currentText={latestInterviewerTurnText}
                  history={transcriptHistory}
                  currentClassName="min-h-10 text-xs leading-5 text-muted-foreground"
                  historyClassName="text-[11px] leading-4 text-muted-foreground/65"
                />
                <div className="mt-2 flex min-w-0 gap-1.5">
                  <Input
                    value={speechCorrectionInput}
                    onChange={(event) =>
                      setSpeechCorrectionInput(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleSpeechCorrectionSubmit();
                      }
                    }}
                    placeholder="Correction: RAG not rec / Glean"
                    className="h-7 min-w-0 text-[10px]"
                    disabled={
                      meeting.status === "starting" ||
                      meeting.status === "reconnecting"
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-[10px]"
                    onClick={handleSpeechCorrectionSubmit}
                    disabled={
                      meeting.status === "starting" ||
                      meeting.status === "reconnecting" ||
                      !speechCorrectionInput.trim()
                    }
                  >
                    Apply
                  </Button>
                </div>
                {meeting.speechCorrections.length ? (
                  <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                    {meeting.speechCorrections.slice(-4).map((correction) => (
                      <Badge
                        key={correction.id}
                        variant="outline"
                        className={cn(
                          "flex max-w-full items-center gap-1 rounded-sm px-1.5 py-0 text-[10px]",
                          correction.deactivatedAt && "opacity-55"
                        )}
                        title={
                          correction.activeQuestion?.error
                            ? `${correction.input}: ${correction.activeQuestion.error}`
                            : correction.input
                        }
                      >
                        {correction.activeQuestion?.regenerationStatus ===
                        "running" ? (
                          <Loader2Icon className="h-2.5 w-2.5 shrink-0 animate-spin" />
                        ) : null}
                        <span className="truncate">
                          {correction.from && correction.to
                            ? `${correction.from} -> ${correction.to}`
                            : correction.term || correction.to}
                          {correction.appliedCount
                            ? ` x${correction.appliedCount}`
                            : ""}
                          {correction.activeQuestion
                            ? ` · ${formatTermCorrectionStatus(
                                correction.activeQuestion.disposition,
                                correction.activeQuestion.regenerationStatus
                              )}`
                            : ""}
                          {correction.deactivatedAt ? " · stopped" : ""}
                        </span>
                        {!correction.deactivatedAt ? (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-4 w-4 shrink-0 p-0"
                            title="Stop future replacement"
                            aria-label={`Stop correction ${correction.from ?? correction.term ?? correction.to ?? correction.id}`}
                            onClick={() =>
                              handleSpeechCorrectionDeactivate(correction.id)
                            }
                          >
                            <XIcon className="h-2.5 w-2.5" />
                          </Button>
                        ) : null}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </section>

              {focusSnapshot.sections.hasTechnicalDetails ? (
                <>
                  <section className="min-w-0 overflow-hidden rounded-md border border-primary/30 bg-primary/5 p-2.5">
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold">
                      <BrainIcon className="h-3.5 w-3.5" />
                      中文思路
                    </div>
                    <MeetingMarkdownText
                      className={CHINESE_THINKING_TEXT_CLASS}
                      value={
                        formatChineseThinkingText(
                          focusSnapshot.sections.chineseThinking
                        ) ||
                        "等待 Jarvis 总结中文思路。"
                      }
                    />
                  </section>

                  <section className="min-w-0 overflow-hidden rounded-md border border-primary/30 bg-primary/5 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <BrainIcon className="h-3.5 w-3.5" />
                      Answer
                      <AdvisePinButton locked={adviseDisplay.locked} updated={adviseDisplay.backgroundUpdated}
                        onClick={() => meeting.toggleAdvisePin({ uiSurface: "normal-mode", displayTarget: adviseDisplay.target })} />
                      {transientPersonalStatusLabel ? (
                        <Badge
                          variant="outline"
                          className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                        >
                          {transientPersonalStatusLabel}
                        </Badge>
                      ) : null}
                      <AnswerDeliveryBadge
                        state={focusSnapshot.answerDelivery.state}
                      />
                    </div>
                    <FactGuardrailNotice notice={focusSnapshot.factGuardrailNotice} />
                    <PhaseOutputNotice notice={focusSnapshot.phaseOutputNotice} />
                    {focusSnapshot.artifactReuseNotice ? <p role="status" className="text-[10px] text-muted-foreground">{focusSnapshot.artifactReuseNotice}</p> : null}
                    <MeetingMarkdownText
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-14 text-sm font-medium leading-6"
                      )}
                      value={
                        focusSnapshot.sections.primaryAnswer || "Waiting for answer."
                      }
                    />
                  </section>

                  {focusSnapshot.sections.whiteboard ? (
                    <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-muted/20 p-3">
                      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                        <FileTextIcon className="h-3.5 w-3.5" />
                        Whiteboard
                        {whiteboardArtifactDisplay.isCached ? (
                          <Badge
                            variant="outline"
                            className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                          >
                            cached
                          </Badge>
                        ) : null}
                      </div>
                      <WhiteboardViewer
                        value={focusSnapshot.sections.whiteboard}
                        viewKey={focusSnapshot.sections.whiteboardViewKey}
                      />
                    </section>
                  ) : null}

                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <MessageSquareTextIcon className="h-3.5 w-3.5" />
                      Task details
                    </div>
                    <div className="space-y-2">
                      <SuggestionBlock
                        label="Question"
                        value={
                          focusSnapshot.sections.focusedQuestion ||
                          "Waiting for focused question."
                        }
                      />
                      <SuggestionBlock
                        label="Approach"
                        value={focusSnapshot.sections.approach || "Not needed yet."}
                      />
                    </div>
                  </section>

                  <CodingArtifactSection
                    code={focusSnapshot.sections.code}
                    complexity={focusSnapshot.sections.complexity}
                    isCached={codingArtifactDisplay.isCached}
                    showEmptyState
                  />
                </>
              ) : (
                <>
                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-2.5">
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold">
                      <BrainIcon className="h-3.5 w-3.5" />
                      中文思路
                    </div>
                    <MeetingMarkdownText
                      className={CHINESE_THINKING_TEXT_CLASS}
                      value={
                        formatChineseThinkingText(
                          focusSnapshot.sections.chineseThinking
                        ) ||
                        "等待 Jarvis 给出中文思路。"
                      }
                    />
                  </section>

                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <MessageSquareTextIcon className="h-3.5 w-3.5" />
                      Answer
                      <AdvisePinButton locked={adviseDisplay.locked} updated={adviseDisplay.backgroundUpdated}
                        onClick={() => meeting.toggleAdvisePin({ uiSurface: "normal-mode", displayTarget: adviseDisplay.target })} />
                      {transientPersonalStatusLabel ? (
                        <Badge
                          variant="outline"
                          className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                        >
                          {transientPersonalStatusLabel}
                        </Badge>
                      ) : null}
                      <AnswerDeliveryBadge
                        state={focusSnapshot.answerDelivery.state}
                      />
                    </div>
                    <FactGuardrailNotice notice={focusSnapshot.factGuardrailNotice} />
                    <PhaseOutputNotice notice={focusSnapshot.phaseOutputNotice} />
                    {focusSnapshot.artifactReuseNotice ? <p role="status" className="text-[10px] text-muted-foreground">{focusSnapshot.artifactReuseNotice}</p> : null}
                    <MeetingMarkdownText
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-20 text-xs leading-5"
                      )}
                      value={
                        focusSnapshot.sections.primaryAnswer ||
                        "Waiting for suggestion."
                      }
                    />
                  </section>

                  {focusSnapshot.sections.code ||
                  focusSnapshot.sections.complexity ? (
                    <CodingArtifactSection
                      code={focusSnapshot.sections.code}
                      complexity={focusSnapshot.sections.complexity}
                      isCached={codingArtifactDisplay.isCached}
                    />
                  ) : null}
                </>
              )}

              {focusSnapshot.latestReliableAnswer ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/30 p-2.5">
                  <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <ClockIcon className="h-3 w-3" />
                    Previous reliable answer
                  </div>
                  <MeetingMarkdownText
                    className={cn(WRAP_TEXT_CLASS, "text-[11px] leading-5 text-muted-foreground")}
                    value={focusSnapshot.latestReliableAnswer}
                  />
                </section>
              ) : null}

              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-2.5">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <SlidersHorizontalIcon className="h-3.5 w-3.5" />
                  Response actions
                </div>
                {hasCorrectableQuestion ? (
                  <div className="mb-2 min-w-0 border-b border-border/50 pb-2">
                    <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                      Current question type
                    </div>
                    <CurrentQuestionTypeControl
                      compact
                      effectiveType={effectiveQuestionType}
                      correction={activeManualQuestionTypeCorrection}
                      onCorrect={(correctedType) => {
                        void meeting.correctActiveQuestionType(
                          correctedType,
                          "normal-mode"
                        );
                      }}
                    />
                  </div>
                ) : null}
                <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_1.75rem] gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      "h-7 px-2 text-[10px]",
                      (isBusy || !hasMeetingContext) &&
                        "cursor-not-allowed opacity-50"
                    )}
                    title="Regenerate with the current Meeting Assistant response settings"
                    onClick={() => {
                      void meeting.regenerateSuggestion({ uiSurface: "normal-mode", displayTarget: adviseDisplay.target });
                    }}
                    aria-disabled={isBusy || !hasMeetingContext}
                  >
                    Regenerate
                  </Button>
                  {responseActionOptions.map((action) => (
                    <Button
                      key={action.id}
                      size="sm"
                      variant="outline"
                      className={cn(
                        "h-7 px-2 text-[10px]",
                        (isBusy ||
                          !hasSuggestion ||
                          !hasActiveMeetingTask) &&
                          "cursor-not-allowed opacity-50"
                      )}
                      title={action.title}
                      onClick={() => {
                        void meeting.applyResponseAction(action.id, { uiSurface: "normal-mode", displayTarget: adviseDisplay.target });
                      }}
                      aria-disabled={
                        isBusy ||
                        !hasSuggestion ||
                        !hasActiveMeetingTask
                      }
                    >
                      {action.label}
                    </Button>
                  ))}
                  <Button
                    size="icon"
                    variant="outline"
                    className={cn(
                      "h-7 w-7",
                      (isBusy ||
                        !hasSuggestion ||
                        !hasActiveMeetingTask) &&
                        "cursor-not-allowed opacity-50"
                    )}
                    title="Regenerate artifacts"
                    onClick={() => {
                      void meeting.applyResponseAction(
                        "regenerate-artifacts", { uiSurface: "normal-mode", displayTarget: adviseDisplay.target }
                      );
                    }}
                    aria-disabled={
                      isBusy ||
                      !hasSuggestion ||
                      !hasActiveMeetingTask
                    }
                  >
                    <RefreshCwIcon className="h-3.5 w-3.5" />
                    <span className="sr-only">Regenerate artifacts</span>
                  </Button>
                </div>
              </section>

              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Clarifying question
                </div>
                <MeetingMarkdownText
                  className={cn(
                    WRAP_TEXT_CLASS,
                    "min-h-14 text-xs leading-5"
                  )}
                  value={
                    showClarifyingQuestion
                      ? clarifyingQuestion
                      : clarifyingQuestion
                        ? "Dismissed for this suggestion."
                        : "Not needed yet."
                  }
                />
                {showClarifyingQuestion ? (
                  <ClarifyingActionButtons
                    isBusy={focusSnapshot.isBusy}
                    selectedAnswerLabel={activeClarifyingSelection?.label}
                    selectionState={activeClarifyingSelection?.status}
                    selectionMessage={formatClarifyingSelectionMessage(
                      activeClarifyingSelection
                    )}
                    isTaskSwitchClarifyingQuestion={
                      isTaskSwitchClarifyingQuestion
                    }
                    clarifyingOptions={focusSnapshot.sections.clarifyingOptions}
                    showBooleanFallback={
                      clarifyingOptionDisplay.showBooleanFallback
                    }
                    onClarifyingAnswer={handleClarifyingAnswer}
                    onNewTaskConfirmation={handleNewTaskConfirmation}
                    onSameTaskConfirmation={handleSameTaskConfirmation}
                    onDismiss={() => {
                      setDismissedQuestionKey(clarifyingQuestionKey);
                    }}
                  />
                ) : null}
              </section>

              <section className="grid grid-cols-3 gap-2">
                <Metric label="Turns" value={meeting.transcriptTurns.length} />
                <Metric
                  label="Screen"
                  value={meeting.screenObservations.length}
                />
                <Metric
                  label="Audio"
                  value={
                    meeting.audioStatus?.sampleRate
                      ? `${Math.round(meeting.audioStatus.sampleRate / 1000)}k`
                      : meeting.audioStatus?.active
                        ? "On"
                        : "Off"
                  }
                />
              </section>

              {meeting.settings.debugMode && traceSummary.traceCount ? (
                <TraceBaselinePanel summary={traceSummary} />
              ) : null}

              {meeting.settings.debugMode &&
              meeting.audioInputLiveness ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                    <ActivityIcon className="h-3.5 w-3.5" />
                    Audio input liveness
                    <Badge
                      variant="outline"
                      className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                    >
                      {meeting.audioInputLiveness.state}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Metric
                      label="Heartbeat"
                      value={
                        meeting.audioInputLiveness.heartbeatAgeMs == null
                          ? "-"
                          : `${meeting.audioInputLiveness.heartbeatAgeMs}ms`
                      }
                    />
                    <Metric
                      label="Candidates"
                      value={
                        meeting.audioInputLiveness.latestEvent
                          ?.speechCandidateCount ?? 0
                      }
                    />
                    <Metric
                      label="Segments"
                      value={
                        meeting.audioInputLiveness.latestEvent
                          ?.segmentEmittedCount ?? 0
                      }
                    />
                  </div>
                  <div
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "mt-2 text-[10px] text-muted-foreground"
                    )}
                  >
                    {meeting.audioInputLiveness.detail}
                  </div>
                  {meeting.audioInputLiveness.latestEvent ? (
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                      rms{" "}
                      {meeting.audioInputLiveness.latestEvent.intervalMaxRms.toFixed(
                        4
                      )}{" "}
                      / peak{" "}
                      {meeting.audioInputLiveness.latestEvent.intervalMaxPeak.toFixed(
                        4
                      )}{" "}
                      / signal{" "}
                      {
                        meeting.audioInputLiveness.latestEvent
                          .intervalSignalChunkCount
                      }
                      /{
                        meeting.audioInputLiveness.latestEvent
                          .intervalChunkCount
                      }{" "}
                      / discarded{" "}
                      {
                        meeting.audioInputLiveness.latestEvent
                          .candidateDiscardedCount
                      }
                    </div>
                  ) : null}
                </section>
              ) : null}

              {meeting.settings.debugMode &&
              meeting.interviewSessionContext?.targetCompany ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                    <BrainIcon className="h-3.5 w-3.5" />
                    Interview context
                  </div>
                  <div className="text-xs font-medium">
                    {meeting.interviewSessionContext.targetCompany.value}
                  </div>
                  <div
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "mt-1 text-[10px] text-muted-foreground"
                    )}
                  >
                    {formatInterviewTargetCompany(
                      meeting.interviewSessionContext.targetCompany
                    )}
                  </div>
                </section>
              ) : null}

              {meeting.settings.debugMode && recentMeTurns.length ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                    <MicIcon className="h-3.5 w-3.5" />
                    Microphone context
                  </div>
                  <div className="space-y-1">
                    {recentMeTurns.map((turn) => (
                      <div
                        key={turn.id}
                        className={cn(
                          WRAP_TEXT_CLASS,
                          "rounded-sm bg-muted/50 p-2 text-[10px] leading-4 text-muted-foreground"
                        )}
                      >
                        <div className="mb-0.5 font-mono uppercase">
                          {turn.contextTier ?? "me"} /{" "}
                          {turn.contextPromptEligible
                            ? "prompt"
                            : "debug-only"}
                        </div>
                        {turn.text}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {meeting.settings.debugMode &&
              meeting.lastMemoryContext?.entries.length ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                    <BrainIcon className="h-3.5 w-3.5" />
                    Injected memory
                  </div>
                  <div className="space-y-2">
                    {meeting.lastMemoryContext.entries.map((item) => (
                      <details
                        key={item.entry.id}
                        className="rounded-sm border border-border/60 p-2"
                      >
                        <summary className="cursor-pointer text-[10px] font-medium">
                          {item.entry.title}
                        </summary>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          score {item.score} /{" "}
                          {item.matchReason.join(", ") || "always"}
                        </div>
                        <pre
                          className={cn(
                            WRAP_TEXT_CLASS,
                            "mt-2 max-h-32 overflow-y-auto overflow-x-hidden rounded-sm bg-muted p-2 text-[10px] leading-4"
                          )}
                        >
                          {item.injectedContent}
                        </pre>
                      </details>
                    ))}
                  </div>
                </section>
              ) : null}

              {meeting.settings.debugMode && latestTrace ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                      <ActivityIcon className="h-3.5 w-3.5" />
                      <span className="truncate">
                        Trace: {formatTraceTitle(latestTrace)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[10px]"
                        title="Export this trace to local app data"
                        onClick={() => {
                          void meeting.exportTrace(latestTrace.id);
                        }}
                      >
                        Export
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[10px]"
                        onClick={meeting.clearTraces}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  {meeting.lastTraceExport ? (
                    <div
                      className="mb-2 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground"
                      title={meeting.lastTraceExport.path}
                    >
                      <span className="shrink-0">Last export:</span>
                      <span className="min-w-0 truncate font-mono">
                        {formatTraceExportName(meeting.lastTraceExport.path)}
                      </span>
                    </div>
                  ) : null}
                  <TraceClassifierMetadata metadata={latestTrace.metadata ?? {}} />
                  <div className="space-y-1">
                    {latestTrace.steps.map((step) => (
                      <div
                        key={step.id}
                        className="flex min-w-0 items-center justify-between gap-2 text-[10px]"
                      >
                        <span className="min-w-0 truncate text-muted-foreground">
                          {step.name}
                        </span>
                        <span className="shrink-0 font-mono">
                          {formatTraceDuration(step.durationMs)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {latestTrace.inputs.length || latestTrace.outputs.length ? (
                    <details className="mt-2 border-t border-border/50 pt-2">
                      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
                        Raw model I/O
                      </summary>
                      <div className="mt-2 space-y-2">
                        {[...latestTrace.inputs, ...latestTrace.outputs].map(
                          (item, index) => (
                            <div key={`${item.label}-${index}`}>
                              <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                                {item.label}
                              </div>
                              <pre
                                className={cn(
                                  WRAP_TEXT_CLASS,
                                  "max-h-40 overflow-y-auto overflow-x-hidden rounded-sm bg-muted p-2 text-[10px] leading-4"
                                )}
                              >
                                {item.value}
                              </pre>
                            </div>
                          )
                        )}
                      </div>
                    </details>
                  ) : null}
                  {hasSuggestion ? (
                    <details className="mt-2 border-t border-border/50 pt-2">
                      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
                        Parsed meeting answer
                      </summary>
                      <pre
                        className={cn(
                          WRAP_TEXT_CLASS,
                          "mt-2 max-h-40 overflow-y-auto overflow-x-hidden rounded-sm bg-muted p-2 text-[10px] leading-4"
                        )}
                      >
                        {formatParsedMeetingAnswer(
                          suggestionSections.parsedAnswer
                        )}
                      </pre>
                    </details>
                  ) : null}
                </section>
              ) : null}

              {meeting.settings.debugMode &&
              evaluationTarget.status !== "none" ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3"
                  onFocusCapture={() => setFrozenEvaluationTarget((previous) => previous ?? currentEvaluationTarget)}>
                  <div className="mb-2 text-xs font-semibold">
                    Attempt evaluation
                    {frozenEvaluationTarget && frozenEvaluationTarget.traceId !== currentEvaluationTarget.traceId ?
                      <Button size="sm" variant="ghost" onClick={() => setFrozenEvaluationTarget(undefined)}>Current target</Button> : null}
                  </div>
                  {evaluationTrace ? (
                    <div className="mb-3 space-y-1 border-b border-border/50 pb-2 text-[10px] text-muted-foreground">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          {evaluationTrace.kind === "screen"
                            ? "Screen"
                            : "Voice"}
                        </span>
                        <span className="shrink-0 font-mono">
                          {evaluationTrace.status}
                          {answerEvaluationProjectionV2?.observed
                            ?.advisorOutcome
                            ? ` / ${answerEvaluationProjectionV2.observed.advisorOutcome}`
                            : ""}
                        </span>
                      </div>
                      {evaluationQuestionSummary ? (
                        <div className="break-words text-foreground">
                          {evaluationQuestionSummary}
                        </div>
                      ) : null}
                      <div
                        className="truncate font-mono"
                        title={evaluationTrace.id}
                      >
                        trace: {evaluationTrace.id}
                      </div>
                      {evaluationTaskId ? (
                        <div
                          className="truncate font-mono"
                          title={evaluationTaskId}
                        >
                          task: {evaluationTaskId}
                        </div>
                      ) : null}
                      {answerEvaluationProjectionV2?.semanticInputEventIds
                        .length ? (
                        <div className="font-medium text-emerald-600 dark:text-emerald-400">
                          Evaluation saved for this attempt
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {evaluationTarget.status === "pending" ? (
                    <div className="text-[10px] text-muted-foreground">
                      Evaluation is available after the answer finishes.
                    </div>
                  ) : evaluationTarget.status === "unavailable" ? (
                    <div className="text-[10px] text-muted-foreground">
                      The visible answer trace is unavailable. Evaluation is
                      disabled to avoid labeling a different trace.
                    </div>
                  ) : evaluationTrace ? (
                    <>
                      <TraceHumanEvaluationPanel
                        key={evaluationTrace.id}
                        trace={evaluationTrace}
                        traces={meeting.traces}
                        detectedQuestionType={formatDetectedQuestionType(
                          evaluationTrace.metadata?.questionType
                        )}
                        detectedPlaybook={formatDetectedQuestionType(
                          evaluationTrace.metadata?.playbookId
                        )}
                        taxonomyAdjudicationCandidateType={
                          typeof evaluationTrace.metadata
                            ?.questionTypeAdjudicationCandidateType ===
                          "string"
                            ? evaluationTrace.metadata
                                .questionTypeAdjudicationCandidateType
                            : typeof evaluationTrace.metadata
                            ?.taxonomyAdjudicationCandidateType === "string"
                              ? evaluationTrace.metadata
                                  .taxonomyAdjudicationCandidateType
                              : undefined
                        }
                        taxonomyAdjudicationDisposition={
                          typeof evaluationTrace.metadata
                            ?.questionTypeAdjudicationDisposition ===
                          "string"
                            ? evaluationTrace.metadata
                                .questionTypeAdjudicationDisposition
                            : typeof evaluationTrace.metadata
                            ?.taxonomyAdjudicationDisposition === "string"
                              ? evaluationTrace.metadata
                                  .taxonomyAdjudicationDisposition
                              : undefined
                        }
                        taxonomyAdjudicationWouldRepair={
                          typeof evaluationTrace.metadata
                            ?.questionTypeAdjudicationWouldRepair ===
                          "boolean"
                            ? evaluationTrace.metadata
                                .questionTypeAdjudicationWouldRepair
                            : typeof evaluationTrace.metadata
                            ?.taxonomyAdjudicationWouldRepair === "boolean"
                              ? evaluationTrace.metadata
                                  .taxonomyAdjudicationWouldRepair
                              : undefined
                        }
                        projectionV2={answerEvaluationProjectionV2}
                        memorySnapshot={answerMemoryEvaluationSnapshot}
                        preparationArtifactUses={
                          answerPreparationArtifactUses
                        }
                        preparationArtifactEvaluations={
                          meeting.preparationArtifactEvaluations
                        }
                        onUpdatePreparationArtifactEvaluation={meeting.updatePreparationArtifactEvaluation}
                        evaluationPersistence={meeting.evaluationPersistence}
                        onRetrySave={meeting.retryHumanEvaluationSave}
                        onRecordGroundTruthV2={(fact, options) => {
                          meeting.recordHumanGroundTruthV2(
                            evaluationTrace.id,
                            fact,
                            {
                              ...options,
                              uiSurface: "normal-debug-evaluation",
                            }
                          );
                        }}
                      />
                    </>
                  ) : null}
                </section>
              ) : null}

              {meeting.settings.debugMode &&
              latestCriticalMomentCandidate ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <CriticalMomentEvaluationPanel
                    candidate={latestCriticalMomentCandidate}
                    evaluation={latestCriticalMomentEvaluation}
                    groundTruth={latestCriticalMomentGroundTruth}
                    traces={latestCriticalMomentTraces}
                    onUpdate={(patch) =>
                      meeting.updateCriticalMomentEvaluation(
                        latestCriticalMomentCandidate.momentId,
                        patch
                      )
                    }
                    onRecordGroundTruth={(fact, options) =>
                      meeting.recordCriticalMomentGroundTruthV2(
                        latestCriticalMomentCandidate.momentId,
                        fact,
                        {
                          ...options,
                          uiSurface: "critical-moment-review",
                        }
                      )
                    }
                  />
                </section>
              ) : null}

              {meeting.settings.debugMode && latestCaptureTarget ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                    <CameraIcon className="h-3.5 w-3.5" />
                    Last capture
                  </div>
                  <div className="truncate text-xs">
                    {formatCaptureTargetName(latestCaptureTarget)}
                  </div>
                  <div
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "mt-1 text-[10px] text-muted-foreground"
                    )}
                  >
                    {formatCaptureTargetBounds(latestCaptureTarget)}
                  </div>
                  <div
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "mt-1 text-[10px] text-muted-foreground"
                    )}
                  >
                    {formatCaptureTargetMethod(latestCaptureTarget)}
                  </div>
                  {latestCaptureTarget.cursor ? (
                    <div
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "mt-1 flex items-start gap-1 text-[10px] text-muted-foreground"
                      )}
                    >
                      <MousePointer2Icon className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        {formatCaptureCursorFocus(latestCaptureTarget)}
                      </span>
                    </div>
                  ) : null}
                  {latestScreenObservation?.analysisPromptSource ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Prompt:{" "}
                      {formatScreenPromptSource(
                        latestScreenObservation.analysisPromptSource
                      )}
                    </div>
                  ) : null}
                  {latestCaptureTarget.fallbackReason ? (
                    <div className="mt-1 text-[10px] text-amber-700">
                      {latestCaptureTarget.fallbackReason}
                    </div>
                  ) : null}
                  {latestScreenObservation?.imageBase64 ? (
                    <img
                      alt="Last captured screen preview"
                      src={`data:${
                        latestScreenObservation.imageMediaType || "image/png"
                      };base64,${latestScreenObservation.imageBase64}`}
                      className="mt-2 h-20 w-full rounded-sm border border-border/50 object-cover"
                    />
                  ) : null}
                  {latestScreenObservation?.focusImageBase64 ? (
                    <div className="mt-2">
                      <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                        Focus band
                      </div>
                      <img
                        alt="Cursor focus band preview"
                        src={`data:${
                          latestScreenObservation.focusImageMediaType ||
                          "image/jpeg"
                        };base64,${latestScreenObservation.focusImageBase64}`}
                        className="h-24 w-full rounded-sm border border-border/50 object-cover"
                      />
                    </div>
                  ) : null}
                  {latestCaptureTarget.candidates?.length ? (
                    <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
                      {latestCaptureTarget.candidates
                        .slice(0, 4)
                        .map((candidate, index) => (
                          <div
                            key={`${candidate.appName}-${candidate.title}-${index}`}
                            className="truncate text-[10px] text-muted-foreground"
                          >
                            {index + 1}. {formatCaptureCandidate(candidate)}
                          </div>
                        ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </ScrollArea>

          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2 overflow-hidden border-t border-border/50 p-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-xs"
              onClick={() => {
                setOpen(false);
              }}
            >
              <PauseIcon className="h-3.5 w-3.5" />
              Hide panel
            </Button>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                title="Clear active task"
                onClick={meeting.clearActiveTask}
                disabled={!hasActiveMeetingTask}
              >
                <Trash2Icon className="h-3.5 w-3.5" />
                Clear task
              </Button>
              <Button
                size="sm"
                variant={
                  audioPauseResumeControl.urgent ? "destructive" : "outline"
                }
                className="h-8 gap-1.5 text-xs"
                title={audioPauseResumeControl.title}
                onClick={handlePauseResume}
                disabled={audioPauseResumeControl.disabled}
              >
                {audioPauseResumeControl.busy ? (
                  <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                ) : audioPauseResumeControl.action === "pause" ? (
                  <PauseIcon className="h-3.5 w-3.5" />
                ) : (
                  <PlayIcon className="h-3.5 w-3.5" />
                )}
                {audioPauseResumeControl.label}
              </Button>
              <Button
                size="sm"
                variant={primaryAudioAction === "stop" ? "destructive" : "default"}
                className="h-8 gap-1.5 text-xs"
                onClick={handleToggle}
              >
                {primaryAudioAction === "stop" ? (
                  <SquareIcon className="h-3.5 w-3.5" />
                ) : (
                  <PlayIcon className="h-3.5 w-3.5" />
                )}
                {primaryAudioActionLabel}
              </Button>
            </div>
          </div>
            </>
          )}
        </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
};

const FocusModePanel = ({
  advisePin,
  onToggleAdvisePin,
  suggestionSections,
  codingArtifactCached,
  whiteboardArtifactCached,
  whiteboardViewKey,
  hasCorrectableQuestion,
  effectiveQuestionType,
  factGuardrailNotice,
  phaseOutputNotice,
  artifactReuseNotice,
  transientPersonalStatusLabel,
  answerDeliveryState,
  manualQuestionTypeCorrection,
  onCorrectQuestionType,
  latestTurnText,
  forceAdviseAvailable,
  forceAdvisePending,
  forceAdviseCompleted,
  onForceAdvise,
  speechCorrectionInput,
  onSpeechCorrectionInputChange,
  onSpeechCorrectionSubmit,
  onSpeechCorrectionDeactivate,
  speechCorrections,
  status,
  error,
  audioInputLiveness,
  isBusy,
  audioControl,
  onToggleAudio,
  showClarifyingQuestion,
  clarifyingQuestion,
  clarifyingOptions,
  showClarifyingBooleanFallback,
  selectedClarifyingAnswerLabel,
  clarifyingSelectionState,
  clarifyingSelectionMessage,
  isTaskSwitchClarifyingQuestion,
  onClarifyingAnswer,
  onNewTaskConfirmation,
  onSameTaskConfirmation,
  onDismissClarifyingQuestion,
  brief,
  onBriefChange,
}: {
  suggestionSections: MeetingFocusSnapshot["sections"];
  advisePin?: MeetingFocusSnapshot["advisePin"];
  onToggleAdvisePin: () => void;
  codingArtifactCached: boolean;
  whiteboardArtifactCached: boolean;
  whiteboardViewKey?: string;
  hasCorrectableQuestion: boolean;
  effectiveQuestionType?: CanonicalQuestionType;
  factGuardrailNotice?: AdvisorSuggestion["factGuardrailNotice"];
  phaseOutputNotice?: string;
  artifactReuseNotice?: string;
  transientPersonalStatusLabel?: string;
  answerDeliveryState: AnswerDeliveryPresentation["state"];
  manualQuestionTypeCorrection?: MeetingFocusSnapshot["manualQuestionTypeCorrection"];
  onCorrectQuestionType: (type: CanonicalQuestionType) => void;
  latestTurnText: string;
  forceAdviseAvailable: boolean;
  forceAdvisePending: boolean;
  forceAdviseCompleted: boolean;
  onForceAdvise: () => void;
  speechCorrectionInput: string;
  onSpeechCorrectionInputChange: (value: string) => void;
  onSpeechCorrectionSubmit: () => void;
  onSpeechCorrectionDeactivate: (correctionId: string) => void;
  speechCorrections: SpeechCorrection[];
  status: keyof typeof statusLabel;
  error: string | null;
  audioInputLiveness: AudioInputLivenessPresentation | null;
  isBusy: boolean;
  audioControl: NativeAudioPauseResumeControlPresentation;
  onToggleAudio: () => void;
  showClarifyingQuestion: boolean;
  clarifyingQuestion: string;
  clarifyingOptions: readonly ClarifyingQuestionOption[];
  showClarifyingBooleanFallback: boolean;
  selectedClarifyingAnswerLabel?: string;
  clarifyingSelectionState?: ClarifyingSelectionLifecycleState;
  clarifyingSelectionMessage?: string;
  isTaskSwitchClarifyingQuestion: boolean;
  onClarifyingAnswer: (
    answer: ClarifyingQuestionAnswer,
    option?: { label?: string; value?: string }
  ) => void;
  onNewTaskConfirmation: () => void;
  onSameTaskConfirmation: () => void;
  onDismissClarifyingQuestion: () => void;
  brief?: InterviewSessionBrief;
  onBriefChange: (brief: InterviewSessionBrief | undefined) => void;
}) => {
  const editableBrief = getEditableInterviewSessionBrief(brief);
  const focusAnswer = suggestionSections.primaryAnswer;
  const focusThinking =
    suggestionSections.chineseThinking || "等待 Jarvis 给出中文思路。";

  const updateInterviewTypes = (interviewTypes: InterviewBriefType[]) => {
    const nextBrief: InterviewSessionBrief = {
      ...editableBrief,
      interviewTypes,
      updatedAt: Date.now(),
    };
    onBriefChange(
      isEditableInterviewSessionBriefEmpty(nextBrief) ? undefined : nextBrief
    );
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <ScrollArea className="meeting-assistant-main-scroll min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
          <div className="min-w-0 max-w-full space-y-3 overflow-x-hidden p-3 pb-44">
            <section className="min-w-0 overflow-hidden rounded-md border border-primary/30 bg-primary/5 p-2.5">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold">
                <BrainIcon className="h-3.5 w-3.5" />
                中文思路
              </div>
              <MeetingMarkdownText
                className={CHINESE_THINKING_TEXT_CLASS}
                value={formatChineseThinkingText(focusThinking)}
              />
            </section>

            <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                <MessageSquareTextIcon className="h-3.5 w-3.5" />
                Answer
                <AdvisePinButton locked={advisePin?.locked ?? false} updated={advisePin?.backgroundUpdated} onClick={onToggleAdvisePin} />
                {transientPersonalStatusLabel ? (
                  <Badge
                    variant="outline"
                    className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                  >
                    {transientPersonalStatusLabel}
                  </Badge>
                ) : null}
                <AnswerDeliveryBadge state={answerDeliveryState} />
              </div>
              <FactGuardrailNotice notice={factGuardrailNotice} />
              <PhaseOutputNotice notice={phaseOutputNotice} />
              {artifactReuseNotice ? <p role="status" className="text-[10px] text-muted-foreground">{artifactReuseNotice}</p> : null}
              <MeetingMarkdownText
                className={cn(
                  WRAP_TEXT_CLASS,
                  "min-h-20 text-sm leading-6"
                )}
                value={focusAnswer || "Waiting for answer."}
              />
            </section>

            {suggestionSections.approach ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Approach
                </div>
                <MeetingMarkdownText
                  className={cn(WRAP_TEXT_CLASS, "text-xs leading-5")}
                  value={suggestionSections.approach}
                />
              </section>
            ) : null}

            {suggestionSections.whiteboard ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-muted/20 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <FileTextIcon className="h-3.5 w-3.5" />
                  Whiteboard
                  {whiteboardArtifactCached ? (
                    <Badge
                      variant="outline"
                      className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                    >
                      cached
                    </Badge>
                  ) : null}
                </div>
                <WhiteboardViewer
                  value={suggestionSections.whiteboard}
                  viewKey={whiteboardViewKey}
                />
              </section>
            ) : null}

            {suggestionSections.code || suggestionSections.complexity ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Code & complexity
                  {codingArtifactCached ? (
                    <Badge
                      variant="outline"
                      className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                    >
                      cached
                    </Badge>
                  ) : null}
                </div>
                {suggestionSections.code ? (
                  <pre
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "overflow-x-hidden rounded-sm bg-muted p-2 text-[11px] leading-4"
                    )}
                  >
                    {stripOuterCodeFence(suggestionSections.code)}
                  </pre>
                ) : null}
                {suggestionSections.complexity ? (
                  <MeetingMarkdownText
                    className={cn(WRAP_TEXT_CLASS, "mt-2 text-xs leading-5")}
                    value={suggestionSections.complexity}
                  />
                ) : null}
              </section>
            ) : null}

            {showClarifyingQuestion ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <HelpCircleIcon className="h-3.5 w-3.5" />
                  Clarify
                </div>
                <MeetingMarkdownText
                  className={cn(WRAP_TEXT_CLASS, "text-xs leading-5")}
                  value={clarifyingQuestion}
                />
                <ClarifyingActionButtons
                  isBusy={isBusy}
                  isTaskSwitchClarifyingQuestion={
                    isTaskSwitchClarifyingQuestion
                  }
                  clarifyingOptions={clarifyingOptions}
                  showBooleanFallback={showClarifyingBooleanFallback}
                  selectedAnswerLabel={selectedClarifyingAnswerLabel}
                  selectionState={clarifyingSelectionState}
                  selectionMessage={clarifyingSelectionMessage}
                  onClarifyingAnswer={onClarifyingAnswer}
                  onNewTaskConfirmation={onNewTaskConfirmation}
                  onSameTaskConfirmation={onSameTaskConfirmation}
                  onDismiss={onDismissClarifyingQuestion}
                />
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
        <div className="pointer-events-auto w-full max-w-[760px] rounded-md border border-border/70 bg-background/95 p-2 shadow-lg backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <div className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
              Type
            </div>
            {hasCorrectableQuestion ? (
              <CurrentQuestionTypeControl
                compact
                effectiveType={effectiveQuestionType}
                correction={manualQuestionTypeCorrection}
                onCorrect={onCorrectQuestionType}
              />
            ) : (
              <InterviewTypeButtonGrid
                compact
                value={editableBrief.interviewTypes}
                onChange={updateInterviewTypes}
              />
            )}
            <Button
              size="icon"
              variant={audioControl.urgent ? "destructive" : "outline"}
              className="ml-auto h-8 w-8 shrink-0"
              title={audioControl.title}
              aria-label={audioControl.label}
              onClick={onToggleAudio}
              disabled={audioControl.disabled}
            >
              {audioControl.busy ? (
                <Loader2Icon className="h-3 w-3 shrink-0 animate-spin" />
              ) : audioControl.action === "pause" ? (
                <PauseIcon className="h-3 w-3 shrink-0" />
              ) : (
                <PlayIcon className="h-3 w-3 shrink-0" />
              )}
            </Button>
            {audioInputLiveness?.severity === "warning" ? (
              <span
                className="flex shrink-0 items-center gap-1 text-[10px] text-amber-700"
                title={audioInputLiveness.detail}
              >
                <ActivityIcon className="h-3 w-3" />
                Audio
              </span>
            ) : null}
            <span
              className={cn(
                "shrink-0 text-[10px]",
                error ? "text-red-700" : "text-muted-foreground"
              )}
              title={[
                error || statusLabel[status],
                `Focus ${FOCUS_MODE_SHORTCUT_LABEL}`,
                `Listen ${FOCUS_LISTENING_SHORTCUT_LABEL}`,
                `Regenerate ${FOCUS_REGENERATE_SHORTCUT_LABEL}`,
                `Enhance ${FOCUS_ENHANCE_CONTEXT_SHORTCUT_LABEL}`,
                `Narrow ${FOCUS_NARROW_CONTEXT_SHORTCUT_LABEL}`,
                `Back ${FOCUS_PREVIOUS_PHASE_SHORTCUT_LABEL}`,
                `Next ${FOCUS_NEXT_PHASE_SHORTCUT_LABEL}`,
              ].join(" / ")}
            >
              {error ? "Error" : statusLabel[status]}
            </span>
          </div>
          <div className="mt-1.5 flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                <MessageSquareTextIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">Latest transcript</span>
                <Button
                  size="sm"
                  variant="outline"
                  className={cn(
                    "ml-auto h-6 shrink-0 gap-1 px-2 text-[10px]",
                    !forceAdviseAvailable && "cursor-not-allowed opacity-50"
                  )}
                  onClick={onForceAdvise}
                  aria-disabled={!forceAdviseAvailable}
                  title={
                    forceAdviseAvailable
                      ? "Force one advisor response for this transcript"
                      : forceAdvisePending
                        ? "Advisor repair is running"
                        : forceAdviseCompleted
                          ? "This transcript has already been advised"
                          : "No recoverable interviewer turn is available"
                  }
                >
                  {forceAdvisePending ? (
                    <Loader2Icon className="h-3 w-3 animate-spin" />
                  ) : (
                    <BrainIcon className="h-3 w-3" />
                  )}
                  {forceAdvisePending
                    ? "Advising"
                    : forceAdviseCompleted
                      ? "Advised"
                      : "Advise"}
                </Button>
              </div>
              <TranscriptLineageWindow
                currentText={latestTurnText}
                history={[]}
                className="min-h-[80px] max-h-24 overflow-y-auto pr-1"
                currentClassName="text-[11px] leading-4 text-muted-foreground"
                historyClassName="text-[10px] leading-4 text-muted-foreground/60"
              />
            </div>
            <div className="min-w-0 flex-[1.1]">
              <SpeechCorrectionControl
                compact
                value={speechCorrectionInput}
                onChange={onSpeechCorrectionInputChange}
                onSubmit={onSpeechCorrectionSubmit}
                onDeactivate={onSpeechCorrectionDeactivate}
                disabled={
                  status === "starting" || status === "reconnecting"
                }
                corrections={speechCorrections}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const TranscriptLineageWindow = ({
  currentText,
  history,
  className,
  currentClassName,
  historyClassName,
}: {
  currentText: string;
  history: DisplayTranscriptHistoryEntry[];
  className?: string;
  currentClassName?: string;
  historyClassName?: string;
}) => (
  <div className={cn("min-w-0", className)}>
    {history.length ? (
      <div className="mb-1.5 space-y-1.5 border-b border-border/50 pb-1.5">
        {history.map((entry) => (
          <p
            key={entry.utteranceId}
            className={cn(WRAP_TEXT_CLASS, historyClassName)}
          >
            {entry.text}
          </p>
        ))}
      </div>
    ) : null}
    <p className={cn(WRAP_TEXT_CLASS, currentClassName)}>{currentText}</p>
  </div>
);

const InterviewTypeButtonGrid = ({
  value,
  onChange,
  compact = false,
  forceSingleConcrete = false,
}: {
  value: InterviewBriefType[];
  onChange: (value: InterviewBriefType[]) => void;
  compact?: boolean;
  forceSingleConcrete?: boolean;
}) => {
  return (
    <div
      className={cn(
        compact
          ? "flex min-w-0 flex-wrap gap-1"
          : "grid grid-cols-2 gap-1 md:grid-cols-5"
      )}
    >
      {interviewBriefTypeOptions.map((option) => {
        const selected = value.includes(option.id);

        return (
          <Button
            key={option.id}
            size="sm"
            variant={selected ? "default" : "outline"}
            className={cn(
              "h-7 px-1 text-[10px]",
              compact && "h-6 shrink-0 px-1.5"
            )}
            title={option.label}
            onClick={() => {
              onChange(
                toggleInterviewBriefType(
                  value,
                  option.id,
                  forceSingleConcrete
                )
              );
            }}
          >
            {compact ? option.shortLabel : option.label}
          </Button>
        );
      })}
    </div>
  );
};

const CurrentQuestionTypeControl = ({
  effectiveType,
  correction,
  onCorrect,
  compact = false,
}: {
  effectiveType?: CanonicalQuestionType;
  correction?: MeetingFocusSnapshot["manualQuestionTypeCorrection"];
  onCorrect: (type: CanonicalQuestionType) => void;
  compact?: boolean;
}) => {
  const isPending =
    correction?.status === "pending" ||
    correction?.regenerationStatus === "running";
  const statusLabel = isPending
    ? `Correcting to ${formatQuestionTypeLabel(correction.correctedType)}...`
    : correction?.regenerationStatus === "failed"
      ? `Type corrected to ${formatQuestionTypeLabel(
          correction.correctedType
        )}; regeneration failed`
      : correction?.regenerationStatus === "succeeded"
        ? `Corrected to ${formatQuestionTypeLabel(correction.correctedType)}`
        : undefined;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {currentQuestionTypeOptions.map((option) => {
        const selected = option.id === effectiveType;

        return (
          <Button
            key={option.id}
            size="sm"
            variant={selected ? "default" : "outline"}
            className={cn(
              "h-7 min-w-[72px] px-2 text-[10px]",
              compact && "h-6 min-w-[64px] shrink-0 px-1.5"
            )}
            title={`Correct the current question to ${option.label}`}
            onClick={() => onCorrect(option.id)}
          >
            {option.shortLabel}
          </Button>
        );
      })}
      {statusLabel ? (
        <span
          className={cn(
            "ml-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground",
            correction?.regenerationStatus === "failed" && "text-red-700"
          )}
          title={correction?.error || statusLabel}
        >
          {isPending ? (
            <Loader2Icon className="h-3 w-3 shrink-0 animate-spin" />
          ) : null}
          <span className="max-w-44 truncate">{statusLabel}</span>
        </span>
      ) : null}
    </div>
  );
};

const SpeechCorrectionControl = ({
  value,
  onChange,
  onSubmit,
  onDeactivate,
  disabled,
  corrections,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onDeactivate: (correctionId: string) => void;
  disabled: boolean;
  corrections: SpeechCorrection[];
  compact?: boolean;
}) => {
  return (
    <>
      <div className={cn("mt-2 flex min-w-0 gap-1.5", compact && "mt-1.5")}>
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Correction: RAG not rec / Glean"
          className={cn(
            "h-7 min-w-0 text-[10px]",
            compact && "h-6 focus-visible:ring-inset"
          )}
          disabled={disabled}
        />
        <Button
          size="sm"
          variant="outline"
          className={cn("h-7 shrink-0 px-2 text-[10px]", compact && "h-6")}
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
        >
          Apply
        </Button>
      </div>
      {corrections.length ? (
        <div className="mt-2 flex max-h-16 min-w-0 flex-wrap gap-1 overflow-y-auto">
          {corrections.slice(-4).map((correction) => (
            <Badge
              key={correction.id}
              variant="outline"
              className={cn(
                "flex max-w-full items-center gap-1 rounded-sm px-1.5 py-0 text-[10px]",
                correction.deactivatedAt && "opacity-55"
              )}
              title={
                correction.activeQuestion?.error
                  ? `${correction.input}: ${correction.activeQuestion.error}`
                  : correction.input
              }
            >
              {correction.activeQuestion?.regenerationStatus === "running" ? (
                <Loader2Icon className="h-2.5 w-2.5 shrink-0 animate-spin" />
              ) : null}
              <span className="truncate">
                {correction.from && correction.to
                  ? `${correction.from} -> ${correction.to}`
                  : correction.term || correction.to}
                {correction.appliedCount
                  ? ` x${correction.appliedCount}`
                  : ""}
                {correction.activeQuestion
                  ? ` · ${formatTermCorrectionStatus(
                      correction.activeQuestion.disposition,
                      correction.activeQuestion.regenerationStatus
                    )}`
                  : ""}
                {correction.deactivatedAt ? " · stopped" : ""}
              </span>
              {!correction.deactivatedAt ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-4 w-4 shrink-0 p-0"
                  title="Stop future replacement"
                  aria-label={`Stop correction ${correction.from ?? correction.term ?? correction.to ?? correction.id}`}
                  onClick={() => onDeactivate(correction.id)}
                >
                  <XIcon className="h-2.5 w-2.5" />
                </Button>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : null}
    </>
  );
};

function formatTermCorrectionStatus(
  disposition: NonNullable<SpeechCorrection["activeQuestion"]>["disposition"],
  regenerationStatus: NonNullable<
    SpeechCorrection["activeQuestion"]
  >["regenerationStatus"]
) {
  if (disposition === "future-speech-bias") return "bias";
  if (disposition === "stale-rejected") return "stale";
  if (regenerationStatus === "running") return "updating";
  if (regenerationStatus === "succeeded") return "updated";
  if (regenerationStatus === "failed") return "failed";
  if (regenerationStatus === "cancelled") return "cancelled";
  return "accepted";
}

const ClarifyingActionButtons = ({
  isBusy,
  selectedAnswerLabel,
  selectionState,
  selectionMessage,
  isTaskSwitchClarifyingQuestion,
  clarifyingOptions,
  showBooleanFallback,
  onClarifyingAnswer,
  onNewTaskConfirmation,
  onSameTaskConfirmation,
  onDismiss,
}: {
  isBusy: boolean;
  selectedAnswerLabel?: string;
  selectionState?: ClarifyingSelectionLifecycleState;
  selectionMessage?: string;
  isTaskSwitchClarifyingQuestion: boolean;
  clarifyingOptions: readonly ClarifyingQuestionOption[];
  showBooleanFallback: boolean;
  onClarifyingAnswer: (
    answer: ClarifyingQuestionAnswer,
    option?: { label?: string; value?: string }
  ) => void;
  onNewTaskConfirmation: () => void;
  onSameTaskConfirmation: () => void;
  onDismiss: () => void;
}) => {
  const renderButton = ({
    label,
    icon,
    onClick,
    variant = "outline",
    key,
  }: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
    variant?: "outline" | "ghost";
    key?: string;
  }) => {
    const isSelected = selectedAnswerLabel === label;

    return (
      <Button
        key={key}
        size="sm"
        variant={isSelected ? "default" : variant}
        className={cn(
          "h-auto min-h-8 min-w-0 gap-1 px-2 py-1.5 text-[10px] leading-3",
          isSelected ? "border-primary" : ""
        )}
        title={label}
        onClick={onClick}
        disabled={isBusy || selectionState === "pending"}
        aria-pressed={isSelected}
      >
        {icon}
        <span className="min-w-0 whitespace-normal break-words text-left">
          {label}
        </span>
      </Button>
    );
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {isTaskSwitchClarifyingQuestion || showBooleanFallback ? (
          <>
            {renderButton({
              icon: <CheckIcon className="h-3 w-3 shrink-0" />,
              label: isTaskSwitchClarifyingQuestion ? "New task" : "Yes",
              onClick: isTaskSwitchClarifyingQuestion
                ? onNewTaskConfirmation
                : () => onClarifyingAnswer("yes"),
            })}
            {renderButton({
              icon: <XIcon className="h-3 w-3 shrink-0" />,
              label: isTaskSwitchClarifyingQuestion ? "Same task" : "No",
              onClick: isTaskSwitchClarifyingQuestion
                ? onSameTaskConfirmation
                : () => onClarifyingAnswer("no"),
            })}
          </>
        ) : clarifyingOptions.length ? (
          clarifyingOptions.slice(0, 4).map((option) =>
            renderButton({
              key: option.id,
              label: option.label,
              onClick: () => {
                onClarifyingAnswer("option", {
                  label: option.label,
                  value: option.value,
                });
              },
            })
          )
        ) : null}
        {renderButton({
          icon: <HelpCircleIcon className="h-3 w-3 shrink-0" />,
          label: "Not sure",
          onClick: () => onClarifyingAnswer("not-sure"),
        })}
        {renderButton({
          icon: <EyeOffIcon className="h-3 w-3 shrink-0" />,
          label: "Dismiss",
          onClick: onDismiss,
          variant: "ghost",
        })}
      </div>
      {selectedAnswerLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 rounded-sm bg-primary/10 px-2 py-1 text-[10px] text-primary">
          {selectionState === "pending" ? (
            <Loader2Icon className="h-3 w-3 animate-spin" />
          ) : selectionState === "succeeded" ? (
            <CheckIcon className="h-3 w-3" />
          ) : null}
          <span className="min-w-0 truncate">
            {selectionMessage ?? `Selected: ${selectedAnswerLabel}.`}
          </span>
        </div>
      ) : null}
    </div>
  );
};

function formatClarifyingSelectionMessage(
  selection: ClarifyingSelectionState | null
) {
  if (!selection) return undefined;
  if (selection.status === "pending") {
    return `Selected: ${selection.label}. Jarvis is updating.`;
  }
  if (selection.status === "succeeded") {
    return `Applied: ${selection.label}.`;
  }
  if (selection.status === "failed") {
    return `Could not apply ${selection.label}. Select it again to retry.`;
  }
  return `Selection expired: ${selection.label}.`;
}

const InterviewSessionBriefPanel = ({
  open,
  onOpenChange,
  brief,
  onBriefChange,
  onClear,
  preparationRuntime,
  onPreparationRuntimeChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brief?: InterviewSessionBrief;
  onBriefChange: (brief: InterviewSessionBrief | undefined) => void;
  onClear: () => void;
  preparationRuntime: PreparationRuntimePresentation;
  onPreparationRuntimeChange: (update: {
    runtimeReinforcementEnabled?: boolean;
    personalizedGuidanceEnabled?: boolean;
  }) => Promise<void>;
}) => {
  const editableBrief = getEditableInterviewSessionBrief(brief);
  const hasBrief = !isEditableInterviewSessionBriefEmpty(editableBrief);

  const updateBrief = (patch: Partial<InterviewSessionBrief>) => {
    onBriefChange({
      ...editableBrief,
      ...patch,
      updatedAt: Date.now(),
    });
  };

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border/70">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 p-3 text-left transition-colors hover:bg-muted/40"
        onClick={() => onOpenChange(!open)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <FileTextIcon className="h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold">Interview Brief</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {formatInterviewBriefSummary(editableBrief)}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasBrief ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              Active
            </Badge>
          ) : null}
          <ChevronDownIcon
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </div>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border/50 p-3">
          <div className="space-y-2 rounded-sm border border-border/60 p-2.5">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Preparation snapshot
                </div>
                <div className="mt-0.5 truncate text-xs font-medium">
                  {formatPreparationRuntimeIdentity(preparationRuntime)}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {formatPreparationRuntimeDetail(preparationRuntime)}
                </div>
              </div>
              <Badge
                variant="outline"
                className="h-5 shrink-0 px-1.5 text-[10px]"
              >
                {preparationRuntime.mode === "prepared" &&
                preparationRuntime.loadState === "ready"
                  ? "Prepared"
                  : "Neutral"}
              </Badge>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium">
                  Prepared Runtime Context
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Brief, round prior, coding language, and speech terms
                </div>
              </div>
              <Switch
                checked={
                  preparationRuntime.capabilities.runtimeReinforcement.enabled
                }
                disabled={
                  !preparationRuntime.capabilities.runtimeReinforcement
                    .available
                }
                onCheckedChange={(runtimeReinforcementEnabled) => {
                  void onPreparationRuntimeChange({
                    runtimeReinforcementEnabled,
                  });
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium">
                  Personalized Guidance
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Strategy, evidence, narratives, and playbook overlays
                </div>
              </div>
              <Switch
                checked={
                  preparationRuntime.capabilities.personalizedGuidance.enabled
                }
                disabled={
                  !preparationRuntime.capabilities.personalizedGuidance
                    .available ||
                  !preparationRuntime.capabilities.runtimeReinforcement.enabled
                }
                onCheckedChange={(personalizedGuidanceEnabled) => {
                  void onPreparationRuntimeChange({
                    personalizedGuidanceEnabled,
                  });
                }}
              />
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
                Target company
              </Label>
              <Input
                value={editableBrief.targetCompany}
                placeholder="Amazon, OpenAI, Anthropic..."
                className="h-8 text-xs"
                onChange={(event) => {
                  const targetCompany = event.currentTarget.value;
                  updateBrief({
                    targetCompany,
                    companyLocked: targetCompany.trim()
                      ? editableBrief.companyLocked
                      : false,
                  });
                }}
              />
            </div>
            <div className="flex min-w-[170px] items-center justify-between gap-2 rounded-sm border border-border/60 p-2">
              <div>
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Lock entered company
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Prevent inferred replacement
                </div>
              </div>
              <Switch
                checked={
                  Boolean(editableBrief.targetCompany.trim()) &&
                  editableBrief.companyLocked
                }
                disabled={!editableBrief.targetCompany.trim()}
                onCheckedChange={(companyLocked) => {
                  updateBrief({ companyLocked });
                }}
              />
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
              Interview type
            </Label>
            <InterviewTypeButtonGrid
              value={editableBrief.interviewTypes}
              onChange={(interviewTypes) => {
                updateBrief({ interviewTypes });
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[10px] text-muted-foreground">
              Manual company and type defaults. Prepared context comes from
              the selected snapshot.
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-[10px]"
              disabled={!hasBrief}
              onClick={onClear}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

function formatPreparationRuntimeIdentity(
  runtime: PreparationRuntimePresentation
) {
  if (runtime.loadState === "loading") return "Loading selected snapshot...";
  if (runtime.loadState === "failed") return "Preparation unavailable";
  if (!runtime.snapshot) return "No selected preparation snapshot";
  return [runtime.snapshot.company, runtime.snapshot.roundTitle]
    .filter(Boolean)
    .join(" · ") || `Snapshot v${runtime.snapshot.version}`;
}

function formatPreparationRuntimeDetail(
  runtime: PreparationRuntimePresentation
) {
  if (runtime.loadFailure?.message) return runtime.loadFailure.message;
  if (!runtime.snapshot) return "Jarvis is using neutral meeting context.";
  return [
    runtime.snapshot.role,
    runtime.snapshot.stage,
    `v${runtime.snapshot.version}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const ConfigurationsPanel = ({
  open,
  onOpenChange,
  responseConfig,
  onResponseConfigChange,
  codingModel,
  onCodingModelChange,
  taxonomyAdjudication,
  onTaxonomyAdjudicationChange,
  aiProviders,
  activeScreenTaskTimeoutMinutes,
  onActiveScreenTaskTimeoutMinutesChange,
  useMemory,
  onUseMemoryChange,
  personalEvidenceGuardrailMode,
  onPersonalEvidenceGuardrailModeChange,
  semanticTaxonomyMode,
  onSemanticTaxonomyModeChange,
  audioProfile,
  audioConfig,
  onAudioProfileChange,
  onAudioConfigChange,
  microphoneContextEnabled,
  onMicrophoneContextEnabledChange,
  debugMode,
  onDebugModeChange,
  nativeAudioFaultAvailable,
  nativeAudioFaultFeedback,
  onNativeAudioFaultInject,
  sessionRecording,
  scriptedValidation,
  onSessionRecordingChange,
  onSessionRecordingStop,
  onSessionRecordingAbandon,
  onSessionScriptedValidationChange,
  runtimeRegression,
  onStartRuntimeRegressionRun,
  onStopRuntimeRegressionRun,
  onResetRuntimeRegressionRun,
  onSubmitRuntimeRegressionText,
  sttEvaluationCapture,
  sttEvaluationCaptureCanEnable,
  onSttEvaluationCaptureChange,
  onDeleteSttEvaluationCapture,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  responseConfig: MeetingResponseConfig;
  onResponseConfigChange: (config: MeetingResponseConfig) => void;
  codingModel: MeetingCodingModelSettings;
  onCodingModelChange: (config: MeetingCodingModelSettings) => void;
  taxonomyAdjudication: MeetingTaxonomyAdjudicationSettings;
  onTaxonomyAdjudicationChange: (
    config: MeetingTaxonomyAdjudicationSettings
  ) => void;
  aiProviders: TYPE_PROVIDER[];
  activeScreenTaskTimeoutMinutes: number;
  onActiveScreenTaskTimeoutMinutesChange: (minutes: number) => void;
  useMemory: boolean;
  onUseMemoryChange: (enabled: boolean) => void;
  personalEvidenceGuardrailMode: PersonalEvidenceGuardrailMode;
  onPersonalEvidenceGuardrailModeChange: (
    mode: PersonalEvidenceGuardrailMode
  ) => void;
  semanticTaxonomyMode: SemanticTaxonomyMode;
  onSemanticTaxonomyModeChange: (mode: SemanticTaxonomyMode) => void;
  audioProfile: MeetingAudioProfile;
  audioConfig: MeetingAudioConfig;
  onAudioProfileChange: (profile: MeetingAudioProfile) => void;
  onAudioConfigChange: (config: MeetingAudioConfig) => void;
  microphoneContextEnabled: boolean;
  onMicrophoneContextEnabledChange: (enabled: boolean) => void;
  debugMode: boolean;
  onDebugModeChange: (enabled: boolean) => void;
  nativeAudioFaultAvailable: boolean;
  nativeAudioFaultFeedback: NativeAudioFaultFeedback;
  onNativeAudioFaultInject: (
    kind: NativeAudioDebugFaultKind
  ) => Promise<void>;
  sessionRecording: MeetingSessionRecordingState;
  scriptedValidation: boolean;
  onSessionRecordingChange: (enabled: boolean) => void;
  onSessionRecordingStop: (
    reason: string,
    options?: { throwOnError?: boolean }
  ) => Promise<MeetingSessionRecordingState | undefined>;
  onSessionRecordingAbandon: (
    reason: string
  ) => Promise<MeetingSessionRecordingState | undefined>;
  onSessionScriptedValidationChange: (enabled: boolean) => void;
  runtimeRegression: RuntimeRegressionRunnerPresentation;
  onStartRuntimeRegressionRun: () => Promise<boolean>;
  onStopRuntimeRegressionRun: () => Promise<boolean>;
  onResetRuntimeRegressionRun: () => Promise<boolean>;
  onSubmitRuntimeRegressionText: (text: string) => Promise<boolean>;
  sttEvaluationCapture: SttEvaluationCaptureState;
  sttEvaluationCaptureCanEnable: boolean;
  onSttEvaluationCaptureChange: (enabled: boolean) => void;
  onDeleteSttEvaluationCapture: () => void;
}) => {
  const [replayLabOpen, setReplayLabOpen] = useState(false);
  const [replayText, setReplayText] = useState("");
  const [recordingRecoveryError, setRecordingRecoveryError] = useState<string | null>(null);
  useEffect(() => {
    setRecordingRecoveryError(null);
  }, [sessionRecording.sessionId]);

  const retryRecordingClose = useCallback(async () => {
    if (sessionRecording.lifecycle !== "close-failed") return;
    setRecordingRecoveryError(null);
    try {
      const result = await onSessionRecordingStop("manual-close-retry", { throwOnError: true });
      if (!result || result.lifecycle !== "idle") {
        throw new Error("Recording close is still unresolved.");
      }
    } catch (error) {
      setRecordingRecoveryError(error instanceof Error ? error.message : String(error));
    }
  }, [sessionRecording.lifecycle, onSessionRecordingStop]);

  const abandonRecordingClose = useCallback(async () => {
    if (sessionRecording.lifecycle !== "close-failed") return;
    setRecordingRecoveryError(null);
    try {
      const result = await onSessionRecordingAbandon("explicit-settings-abandon");
      if (!result || result.lifecycle !== "idle") {
        throw new Error("Recording close could not be abandoned.");
      }
    } catch (error) {
      setRecordingRecoveryError(error instanceof Error ? error.message : String(error));
    }
  }, [sessionRecording.lifecycle, onSessionRecordingAbandon]);

  const submitReplayText = useCallback(async () => {
    const accepted = await onSubmitRuntimeRegressionText(replayText);
    if (accepted) setReplayText("");
  }, [onSubmitRuntimeRegressionText, replayText]);

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border/70">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 p-3 text-left transition-colors hover:bg-muted/40"
        onClick={() => onOpenChange(!open)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SettingsIcon className="h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold">Configurations</div>
            <div className="truncate text-[10px] text-muted-foreground">
              Meeting-only settings, independent from main UI
            </div>
          </div>
        </div>
        <ChevronDownIcon
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border/50 p-3">
          <ConfigurationGroup
            icon={<LanguagesIcon className="h-3.5 w-3.5" />}
            title="Response"
          >
            <ConfigButtonGrid
              label="Length"
              options={responseLengthOptions}
              value={responseConfig.length}
              onChange={(length) => {
                onResponseConfigChange({
                  ...responseConfig,
                  length,
                });
              }}
            />
            <ConfigButtonGrid
              label="Language"
              options={responseLanguageOptions}
              value={responseConfig.language}
              onChange={(language) => {
                onResponseConfigChange({
                  ...responseConfig,
                  language,
                });
              }}
            />
            <MeetingModelOverrideConfig
              label="Coding model"
              description="Used only for confirmed coding tasks"
              providers={aiProviders}
              value={codingModel}
              onChange={onCodingModelChange}
            />
          </ConfigurationGroup>

          <ConfigurationGroup
            icon={<ClockIcon className="h-3.5 w-3.5" />}
            title="Context"
          >
            <div>
              <div className="mb-1.5 text-[10px] font-medium uppercase text-muted-foreground">
                Processing
              </div>
              <p className="text-[10px] text-muted-foreground">
                Configured provider API
              </p>
            </div>

            <div>
              <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
                Task memory
              </Label>
              <div className="grid grid-cols-4 gap-1">
                {TASK_TIMEOUT_OPTIONS.map((minutes) => (
                  <Button
                    key={minutes}
                    size="sm"
                    variant={
                      activeScreenTaskTimeoutMinutes === minutes
                        ? "default"
                        : "outline"
                    }
                    className="h-7 px-1 text-[10px]"
                    onClick={() => {
                      onActiveScreenTaskTimeoutMinutesChange(minutes);
                    }}
                  >
                    {formatTaskTimeout(minutes)}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-sm border border-border/60 p-2">
              <div>
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Use Memory
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Local curated entries only
                </div>
              </div>
              <Switch checked={useMemory} onCheckedChange={onUseMemoryChange} />
            </div>

            <div className="flex items-center justify-between gap-2 rounded-sm border border-border/60 p-2">
              <div>
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Personal Fact Guardrail
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {personalEvidenceGuardrailMode === "enforcement"
                    ? "Enforcement mode"
                    : "Shadow mode (trace only)"}
                </div>
              </div>
              <Switch
                checked={personalEvidenceGuardrailMode === "enforcement"}
                onCheckedChange={(enabled) => {
                  onPersonalEvidenceGuardrailModeChange(
                    enabled ? "enforcement" : "shadow"
                  );
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2 rounded-sm border border-border/60 p-2">
              <div>
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Semantic Type Rescue
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {semanticTaxonomyMode === "enforcement"
                    ? "Enforce calibrated unknown-only rescue"
                    : "Shadow mode (recommended)"}
                </div>
              </div>
              <Switch
                checked={semanticTaxonomyMode === "enforcement"}
                onCheckedChange={(enabled) => {
                  onSemanticTaxonomyModeChange(
                    enabled ? "enforcement" : "shadow"
                  );
                }}
              />
            </div>

            <div className="space-y-2 rounded-sm border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-medium uppercase text-muted-foreground">
                    Meeting Metadata Enforcement
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {taxonomyAdjudication.meetingMetadataMode ===
                    "enforcement"
                      ? "Fill an empty company from grounded opening evidence"
                      : "Shadow only; company stays unknown"}
                  </div>
                </div>
                <Switch
                  checked={
                    taxonomyAdjudication.meetingMetadataMode ===
                    "enforcement"
                  }
                  onCheckedChange={(enabled) => {
                    onTaxonomyAdjudicationChange({
                      ...taxonomyAdjudication,
                      enabled: true,
                      meetingMetadataMode: enabled
                        ? "enforcement"
                        : "shadow",
                    });
                  }}
                />
              </div>
              <MeetingModelOverrideConfig
                label="Fast Runtime model"
                description="Used by bounded low-complexity checks; Question Type and Relation are always active and inherit the session's Main Advisor model"
                providers={aiProviders}
                value={taxonomyAdjudication}
                onChange={(selected) => {
                  onTaxonomyAdjudicationChange({
                    enabled: true,
                    questionTypeMode: "enforcement",
                    taskRelationMode: "shadow",
                    meetingMetadataMode:
                      taxonomyAdjudication.meetingMetadataMode,
                    ...selected,
                  });
                }}
              />
            </div>
          </ConfigurationGroup>

          <ConfigurationGroup
            icon={<Volume2Icon className="h-3.5 w-3.5" />}
            title="Audio"
          >
            <div className="flex items-center justify-between gap-2 rounded-sm border border-border/60 p-2">
              <div>
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Mic Context
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Capture your short clarifications as local context
                </div>
              </div>
              <Switch
                checked={microphoneContextEnabled}
                onCheckedChange={onMicrophoneContextEnabledChange}
              />
            </div>

            <div>
              <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
                Profile
              </Label>
              <div className="grid grid-cols-3 gap-1">
                {meetingAudioProfileOptions.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={
                      audioProfile === option.id ? "default" : "outline"
                    }
                    className="h-7 px-1 text-[10px]"
                    onClick={() => {
                      onAudioProfileChange(option.id);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              {audioProfile === "custom" ? (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Custom values
                </div>
              ) : null}
            </div>

            <MeetingAudioSlider
              label="Speech sensitivity"
              value={audioConfig.sensitivity_rms * 1000}
              displayValue={(audioConfig.sensitivity_rms * 1000).toFixed(1)}
              min={1}
              max={20}
              step={0.5}
              onChange={(value) => {
                onAudioConfigChange({
                  ...audioConfig,
                  sensitivity_rms: value / 1000,
                });
              }}
            />
            <MeetingAudioSlider
              label="Silence duration"
              value={audioConfig.silence_duration_ms}
              displayValue={formatSilenceDuration(audioConfig)}
              min={400}
              max={4_200}
              step={50}
              onChange={(value) => {
                onAudioConfigChange({
                  ...audioConfig,
                  silence_duration_ms: Math.round(value),
                });
              }}
            />
            <MeetingAudioSlider
              label="Noise gate"
              value={audioConfig.noise_gate_threshold * 1000}
              displayValue={(audioConfig.noise_gate_threshold * 1000).toFixed(
                1
              )}
              min={0}
              max={10}
              step={0.1}
              onChange={(value) => {
                onAudioConfigChange({
                  ...audioConfig,
                  noise_gate_threshold: value / 1000,
                });
              }}
            />
            <MeetingAudioSlider
              label="Max segment"
              value={audioConfig.max_recording_duration_secs}
              displayValue={`${Math.round(
                audioConfig.max_recording_duration_secs / 60
              )}m`}
              min={30}
              max={300}
              step={15}
              onChange={(value) => {
                onAudioConfigChange({
                  ...audioConfig,
                  max_recording_duration_secs: Math.round(value),
                });
              }}
            />
          </ConfigurationGroup>

          <ConfigurationGroup
            icon={<ActivityIcon className="h-3.5 w-3.5" />}
            title="Debug"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-medium uppercase text-muted-foreground">
                Debug Mode
              </div>
              <Switch checked={debugMode} onCheckedChange={onDebugModeChange} />
            </div>
            {import.meta.env.DEV && debugMode ? (
              <div className="space-y-1.5 rounded-sm border border-border/60 p-2">
                <div>
                  <div className="text-[10px] font-medium uppercase text-muted-foreground">
                    Native Audio Fault Test
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    Synthetic validation; excluded from reliability metrics
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {(
                    [
                      ["recoverable-stream-end", "Recoverable"],
                      ["fatal-capture-failure", "Fatal"],
                    ] as const
                  ).map(([kind, label]) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant="outline"
                      className="h-7 px-1 text-[10px]"
                      disabled={
                        !nativeAudioFaultAvailable ||
                        Boolean(nativeAudioFaultFeedback.inFlightKind)
                      }
                      onClick={() => {
                        void onNativeAudioFaultInject(kind);
                      }}
                    >
                      {nativeAudioFaultFeedback.inFlightKind === kind ? (
                        <Loader2Icon className="mr-1 h-3 w-3 animate-spin" />
                      ) : null}
                      {label}
                    </Button>
                  ))}
                </div>
                {!nativeAudioFaultAvailable &&
                !nativeAudioFaultFeedback.inFlightKind ? (
                  <div className="text-[10px] text-muted-foreground">
                    Start meeting audio to enable fault injection.
                  </div>
                ) : null}
                {nativeAudioFaultFeedback.message ? (
                  <div
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "text-[10px]",
                      nativeAudioFaultFeedback.status === "error"
                        ? "text-red-600"
                        : "text-muted-foreground"
                    )}
                  >
                    {nativeAudioFaultFeedback.message}
                  </div>
                ) : null}
              </div>
            ) : null}
            {import.meta.env.DEV && debugMode ? (
              <div className="border-t border-border/60 pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <MessageSquareTextIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-[10px] font-medium uppercase text-muted-foreground">
                      Replay Lab
                    </span>
                    <Badge
                      variant="outline"
                      className="h-5 rounded-sm px-1.5 text-[9px]"
                    >
                      {runtimeRegression.status}
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => setReplayLabOpen((value) => !value)}
                  >
                    {replayLabOpen ? "Close" : "Open"}
                  </Button>
                </div>

                {replayLabOpen ? (
                  <div className="mt-2 space-y-2">
                    {!runtimeRegression.active ? (
                      <Button
                        size="sm"
                        className="h-8 w-full text-[10px]"
                        disabled={
                          runtimeRegression.status === "starting" ||
                          sessionRecording.lifecycle !== "idle"
                        }
                        onClick={() => {
                          void onStartRuntimeRegressionRun();
                        }}
                      >
                        {runtimeRegression.status === "starting" ? (
                          <Loader2Icon className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <PlayIcon className="mr-1 h-3 w-3" />
                        )}
                        Start Fresh Run
                      </Button>
                    ) : (
                      <>
                        <Textarea
                          value={replayText}
                          onChange={(event) =>
                            setReplayText(event.target.value)
                          }
                          placeholder="Enter interviewer text"
                          className="min-h-20 resize-y text-xs"
                          disabled={
                            runtimeRegression.status === "running-step" ||
                            runtimeRegression.status === "stopping"
                          }
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              (event.metaKey || event.ctrlKey)
                            ) {
                              event.preventDefault();
                              void submitReplayText();
                            }
                          }}
                        />
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            className="h-8 flex-1 text-[10px]"
                            disabled={
                              !replayText.trim() ||
                              runtimeRegression.status !== "ready"
                            }
                            onClick={() => {
                              void submitReplayText();
                            }}
                          >
                            {runtimeRegression.status === "running-step" ? (
                              <Loader2Icon className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <SendIcon className="mr-1 h-3 w-3" />
                            )}
                            Send
                          </Button>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            title="Reset replay run"
                            disabled={
                              runtimeRegression.status === "running-step" ||
                              runtimeRegression.status === "stopping"
                            }
                            onClick={() => {
                              void onResetRuntimeRegressionRun();
                            }}
                          >
                            <RotateCcwIcon className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            title="Stop replay run"
                            disabled={
                              runtimeRegression.status === "stopping"
                            }
                            onClick={() => {
                              void onStopRuntimeRegressionRun();
                            }}
                          >
                            <SquareIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="min-w-0 text-[10px] text-muted-foreground">
                          <div className="truncate font-mono">
                            {runtimeRegression.scenarioRunId}
                          </div>
                          {runtimeRegression.currentStep ? (
                            <div className="mt-1 flex items-center justify-between gap-2">
                              <span>
                                Step {runtimeRegression.currentStep.ordinal}
                              </span>
                              <span>
                                {runtimeRegression.currentStep.status}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </>
                    )}
                    {runtimeRegression.error ? (
                      <div className="text-[10px] text-red-600">
                        {runtimeRegression.error}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-1.5 rounded-sm border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-medium uppercase text-muted-foreground">
                    Session Recording
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    Local evaluation corpus, no audio
                  </div>
                </div>
                <Switch
                  checked={sessionRecording.active}
                  disabled={
                    sessionRecording.lifecycle === "starting" ||
                    sessionRecording.lifecycle === "closing" ||
                    sessionRecording.lifecycle === "close-failed"
                  }
                  onCheckedChange={onSessionRecordingChange}
                />
              </div>
              {debugMode ? (
                <div className="flex items-center justify-between gap-2 rounded-sm border border-border/50 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium">
                      Scripted validation
                    </div>
                    <div className="text-[9px] text-muted-foreground">
                      Excludes automatic interventions from organic metrics
                    </div>
                  </div>
                  <Switch
                    checked={scriptedValidation}
                    disabled={
                      sessionRecording.lifecycle === "starting" ||
                      sessionRecording.lifecycle === "closing" ||
                      sessionRecording.scriptedValidationForced === true
                    }
                    onCheckedChange={onSessionScriptedValidationChange}
                  />
                </div>
              ) : null}
              {sessionRecording.active || sessionRecording.lifecycle === "close-failed" ? (
                <div className="space-y-1 text-[10px] text-muted-foreground">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="shrink-0">Session:</span>
                    <span className="min-w-0 truncate font-mono">
                      {sessionRecording.sessionId}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="shrink-0">Folder:</span>
                    <span
                      className="min-w-0 truncate font-mono"
                      title={sessionRecording.folderPath}
                    >
                      {sessionRecording.folderPath}
                    </span>
                  </div>
                  <div>
                    {sessionRecording.eventCount} events /{" "}
                    {sessionRecording.artifactCount} artifacts
                  </div>
                </div>
              ) : null}
              {sessionRecording.lifecycle === "close-failed" ? (
                <div className="space-y-2">
                  <p role="status" className="text-[10px] text-destructive">
                    Recording stopped; final save failed. New recordings are blocked.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline"
                      onClick={() => void retryRecordingClose()}>
                      <RotateCcwIcon className="h-3.5 w-3.5" />
                      Retry save
                    </Button>
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button type="button" size="sm" variant="outline">
                          <XIcon className="h-3.5 w-3.5" />
                          Abandon close
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="rounded-lg">
                        <DialogTitle>Abandon this recording close?</DialogTitle>
                        <DialogDescription>
                          This ends the in-process retry for this recording. Its folder
                          will remain on disk and may be incomplete. No files will be
                          deleted. This does not stop the Meeting or quit Jarvis.
                        </DialogDescription>
                        <p className="break-all font-mono text-xs">{sessionRecording.folderPath}</p>
                        <DialogFooter>
                          <DialogClose asChild>
                            <Button type="button" variant="outline">Cancel</Button>
                          </DialogClose>
                          <DialogClose asChild>
                            <Button type="button" variant="destructive"
                              onClick={() => void abandonRecordingClose()}>
                              <XIcon className="h-3.5 w-3.5" />
                              Confirm abandon
                            </Button>
                          </DialogClose>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>
              ) : null}
              {sessionRecording.lifecycle === "starting" ||
              sessionRecording.lifecycle === "closing" ? (
                <div className="text-[10px] text-muted-foreground">
                  {sessionRecording.lifecycle === "starting"
                    ? "Starting recording..."
                    : "Finalizing recording..."}
                </div>
              ) : null}
              {recordingRecoveryError || sessionRecording.lastError ? (
                <div role="alert" className="break-words text-[10px] text-red-600">
                  {recordingRecoveryError || sessionRecording.lastError}
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5 rounded-sm border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-medium uppercase text-muted-foreground">
                    STT Evaluation Capture
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    Local system audio, automatic deletion after 72 hours
                  </div>
                </div>
                <Switch
                  checked={sttEvaluationCapture.active}
                  disabled={
                    sttEvaluationCapture.lifecycle === "starting" ||
                    sttEvaluationCapture.lifecycle === "stopping" ||
                    sttEvaluationCapture.lifecycle === "deleting" ||
                    (!sttEvaluationCapture.active &&
                      !sttEvaluationCaptureCanEnable)
                  }
                  onCheckedChange={onSttEvaluationCaptureChange}
                />
              </div>
              {!sttEvaluationCapture.active &&
              !sttEvaluationCaptureCanEnable &&
              !sttEvaluationCapture.sessionId ? (
                <div className="text-[10px] text-muted-foreground">
                  Turn on Debug Mode or Session Recording, then enable before
                  meeting audio.
                </div>
              ) : null}
              {sttEvaluationCapture.sessionId ? (
                <div className="space-y-1 text-[10px] text-muted-foreground">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="shrink-0">
                      {sttEvaluationCapture.active ? "Recording:" : "Saved:"}
                    </span>
                    <span className="min-w-0 truncate font-mono">
                      {sttEvaluationCapture.folderName}
                    </span>
                  </div>
                  <div
                    className="min-w-0 truncate font-mono"
                    title={sttEvaluationCapture.folderPath}
                  >
                    {sttEvaluationCapture.folderPath}
                  </div>
                  <div>
                    {sttEvaluationCapture.rawChunkCount} raw chunks /{" "}
                    {sttEvaluationCapture.submittedAudioCount} submitted /{" "}
                    {sttEvaluationCapture.providerEventCount} provider /{" "}
                    {sttEvaluationCapture.canonicalEventCount} canonical
                  </div>
                  <div>
                    {formatPayloadSize(sttEvaluationCapture.bytesWritten)}
                    {sttEvaluationCapture.droppedRawChunkCount > 0
                      ? ` / ${sttEvaluationCapture.droppedRawChunkCount} dropped`
                      : ""}
                  </div>
                </div>
              ) : null}
              {sttEvaluationCapture.lifecycle === "starting" ||
              sttEvaluationCapture.lifecycle === "stopping" ||
              sttEvaluationCapture.lifecycle === "deleting" ? (
                <div className="text-[10px] text-muted-foreground">
                  {sttEvaluationCapture.lifecycle === "starting"
                    ? "Starting capture..."
                    : sttEvaluationCapture.lifecycle === "stopping"
                      ? "Finalizing capture..."
                      : "Deleting capture..."}
                </div>
              ) : null}
              {!sttEvaluationCapture.active &&
              sttEvaluationCapture.sessionId ? (
                <div className="flex justify-end">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Delete STT evaluation capture"
                    aria-label="Delete STT evaluation capture"
                    onClick={onDeleteSttEvaluationCapture}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
              {sttEvaluationCapture.lastError ? (
                <div className={cn(WRAP_TEXT_CLASS, "text-[10px] text-red-600")}>
                  {sttEvaluationCapture.lastError}
                </div>
              ) : null}
            </div>
          </ConfigurationGroup>
        </div>
      ) : null}
    </section>
  );
};

const MeetingModelOverrideConfig = ({
  label,
  description,
  providers,
  value,
  onChange,
}: {
  label: string;
  description: string;
  providers: TYPE_PROVIDER[];
  value: MeetingCodingModelSettings;
  onChange: (config: MeetingCodingModelSettings) => void;
}) => {
  const selectedProvider = providers.find(
    (provider) => provider.id === value.provider
  );
  const variables = extractVariables(selectedProvider?.curl ?? "");

  return (
    <div className="space-y-2 rounded-sm border border-border/60 p-2">
      <div>
        <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
          {label}
        </Label>
        <select
          className="h-8 w-full rounded-sm border border-border bg-background px-2 text-xs outline-none transition-colors focus:border-foreground/40"
          value={value.provider}
          onChange={(event) => {
            onChange({
              provider: event.target.value,
              variables: {},
            });
          }}
        >
          <option value="">Same as main model</option>
          {providers
            .filter(
              (provider): provider is TYPE_PROVIDER & { id: string } =>
                Boolean(provider.id)
            )
            .map((provider, index) => (
              <option key={provider.id} value={provider.id}>
                {provider.id || `Provider ${index + 1}`}
              </option>
            ))}
        </select>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {description}
        </div>
      </div>

      {selectedProvider && variables.length > 0 ? (
        <div className="space-y-1.5">
          {variables.map((variable) => (
            <div key={variable.key}>
              <Label className="mb-1 block text-[10px] font-medium uppercase text-muted-foreground">
                {variable.value}
              </Label>
              <Input
                className="h-8 text-xs"
                type={
                  /key|token|secret|password/i.test(variable.key)
                    ? "password"
                    : "text"
                }
                value={value.variables[variable.key] ?? ""}
                onChange={(event) => {
                  onChange({
                    ...value,
                    variables: {
                      ...value.variables,
                      [variable.key]: event.target.value,
                    },
                  });
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ConfigurationGroup = ({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) => {
  return (
    <div className="space-y-2 border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        {icon}
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
};

const ConfigButtonGrid = <T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) => {
  return (
    <div>
      <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </Label>
      <div className="grid grid-cols-3 gap-1">
        {options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={value === option.id ? "default" : "outline"}
            className="h-7 px-1 text-[10px]"
            onClick={() => {
              onChange(option.id);
            }}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
};

const MeetingAudioSlider = ({
  label,
  value,
  displayValue,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  displayValue: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) => {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center justify-between text-[10px] font-medium uppercase text-muted-foreground">
        <span>{label}</span>
        <span className="font-normal normal-case">{displayValue}</span>
      </Label>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([nextValue]) => {
          onChange(nextValue);
        }}
      />
    </div>
  );
};

const Metric = ({ label, value }: { label: string; value: number | string }) => {
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
};

const TraceBaselinePanel = ({
  summary,
}: {
  summary: MeetingTraceSummary;
}) => {
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
          <ClockIcon className="h-3.5 w-3.5" />
          <span className="truncate">Recent latency baseline</span>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          latest {summary.traceCount}/{summary.windowSize} traces, p50 / p90
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <TraceKindSummaryCard
          title="Screen"
          emptyLabel="No screen traces yet"
          summary={summary.screen}
          rows={[
            ["Status", formatTraceStatusCounts(summary.screen)],
            [
              "Capture",
              formatTraceValueRange(summary.screen.captureDurationMs),
            ],
            [
              "Preflight",
              formatTraceValueRange(summary.screen.preflightDurationMs),
            ],
            [
              "First token",
              formatTraceValueRange(summary.screen.firstTokenLatencyMs),
            ],
            ["Model", formatTraceValueRange(summary.screen.modelDurationMs)],
            ["Total", formatTraceValueRange(summary.screen.totalDurationMs)],
            [
              "Image payload",
              formatTraceValueRange(
                summary.screen.imagePayloadChars,
                formatPayloadSize
              ),
            ],
            [
              "Output",
              formatTraceValueRange(summary.screen.outputChars, formatChars),
            ],
          ]}
        />
        <TraceKindSummaryCard
          title="Voice"
          emptyLabel="No voice traces yet"
          summary={summary.voice}
          rows={[
            ["Status", formatTraceStatusCounts(summary.voice)],
            ["STT", formatTraceValueRange(summary.voice.sttDurationMs)],
            [
              "First token",
              formatTraceValueRange(
                summary.voice.advisorFirstTokenLatencyMs
              ),
            ],
            [
              "Advisor",
              formatTraceValueRange(summary.voice.advisorDurationMs),
            ],
            ["Total", formatTraceValueRange(summary.voice.totalDurationMs)],
            [
              "Audio",
              formatTraceValueRange(summary.voice.audioBytes, formatPayloadSize),
            ],
            [
              "Output",
              formatTraceValueRange(summary.voice.outputChars, formatChars),
            ],
          ]}
        />
      </div>
    </section>
  );
};

const TraceKindSummaryCard = ({
  title,
  emptyLabel,
  summary,
  rows,
}: {
  title: string;
  emptyLabel: string;
  summary: MeetingTraceKindSummary;
  rows: Array<[string, string]>;
}) => {
  return (
    <div className="min-w-0 rounded-sm bg-muted/40 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">
          {title}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {summary.total} traces
        </div>
      </div>
      {summary.total ? (
        <div className="space-y-1">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 text-[10px]"
            >
              <span className="min-w-0 truncate text-muted-foreground">
                {label}
              </span>
              <span className="shrink-0 font-mono">{value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground">{emptyLabel}</div>
      )}
    </div>
  );
};

const CriticalMomentEvaluationPanel = ({
  candidate,
  evaluation,
  groundTruth,
  traces,
  onUpdate,
  onRecordGroundTruth,
}: {
  candidate: CriticalMomentCandidate;
  evaluation: CriticalMomentEvaluation | undefined;
  groundTruth: CriticalMomentExpectedFacts | undefined;
  traces: MeetingTrace[];
  onUpdate: (patch: CriticalMomentOutcomeEvaluationPatch) => void;
  onRecordGroundTruth: (
    fact: HumanGroundTruthFactV2,
    options?: {
      actionId?: string;
      confirmation?: "confirmed" | "suggested";
      interaction?: HumanGroundTruthInteractionV2;
    }
  ) => void;
}) => {
  const failureReasons = evaluation?.failureReasons ?? [];
  const [expectedQuestionType, setExpectedQuestionType] =
    useState<CanonicalQuestionType>();
  const [expectedRelation, setExpectedRelation] =
    useState<HumanEvaluationTaskRelation>();
  const [expectedParentAction, setExpectedParentAction] =
    useState<HumanExpectedParentAction>();
  const evaluationOpenedAtRef = useRef<number | undefined>(undefined);
  const evaluationClickCountRef = useRef(0);
  const expandedEvaluationRegionsRef = useRef(new Set<string>());
  const settlementCompatibility =
    expectedRelation && expectedParentAction
      ? evaluateTaskSettlementTupleCompatibilityV2({
          relation: expectedRelation,
          parentAction: expectedParentAction,
        })
      : undefined;

  useEffect(() => {
    setExpectedQuestionType(
      groundTruth?.expectedQuestionType ??
        candidate.proposedQuestionType ??
        "unknown"
    );
    setExpectedRelation(groundTruth?.expectedRelation ?? "none");
    setExpectedParentAction(
      groundTruth?.expectedParentAction ??
        evaluateTaskSettlementTupleCompatibilityV2({
          relation: groundTruth?.expectedRelation ?? "none",
          parentAction: "none",
        }).recommendedParentAction
    );
    evaluationOpenedAtRef.current = undefined;
    evaluationClickCountRef.current = 0;
    expandedEvaluationRegionsRef.current.clear();
  }, [
    candidate.momentId,
    candidate.proposedQuestionType,
    groundTruth?.expectedParentAction,
    groundTruth?.expectedQuestionType,
    groundTruth?.expectedRelation,
    groundTruth?.projectionId,
  ]);

  const toggleFailureReason = (reason: CriticalMomentFailureReason) => {
    onUpdate({
      failureReasons: failureReasons.includes(reason)
        ? failureReasons.filter((candidateReason) => candidateReason !== reason)
        : [...failureReasons, reason],
    });
  };
  const recordGroundTruth = (
    fact: HumanGroundTruthFactV2,
    options?: {
      actionId?: string;
      confirmation?: "confirmed" | "suggested";
    }
  ) => {
    const now = Date.now();
    const startedAt = evaluationOpenedAtRef.current ?? now;
    evaluationOpenedAtRef.current = startedAt;
    onRecordGroundTruth(fact, {
      ...options,
      interaction: {
        startedAt,
        durationMs: now - startedAt,
        clickCount: evaluationClickCountRef.current,
        expandedRegions: Array.from(
          expandedEvaluationRegionsRef.current
        ).sort(),
      },
    });
  };
  const recordTaskSettlement = (allowIncompatibleTuple = false) => {
    if (!expectedQuestionType || !expectedRelation || !expectedParentAction) {
      return;
    }
    if (
      settlementCompatibility?.compatible === false &&
      !allowIncompatibleTuple
    ) {
      return;
    }
    recordGroundTruth(
      {
        kind: "expected-task-settlement",
        expectedQuestionType,
        expectedRelation,
        expectedParentAction,
      },
      {
        actionId: allowIncompatibleTuple
          ? `critical-moment-settlement-override:${candidate.momentId}:${Date.now()}`
          : undefined,
        confirmation: "confirmed",
      }
    );
  };

  return (
    <details
      onClickCapture={() => {
        evaluationOpenedAtRef.current ??= Date.now();
        evaluationClickCountRef.current += 1;
      }}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          evaluationOpenedAtRef.current ??= Date.now();
          expandedEvaluationRegionsRef.current.add(
            "critical-moment-review"
          );
        } else {
          expandedEvaluationRegionsRef.current.delete(
            "critical-moment-review"
          );
        }
      }}
    >
      <summary className="cursor-pointer text-xs font-semibold">
        Critical moment review
      </summary>
      <div className="mt-2 space-y-3">
        <div className="rounded-sm bg-muted/40 p-2">
          <div className={cn(WRAP_TEXT_CLASS, "text-[11px] leading-4")}>
            {candidate.sourceText}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {candidate.traceJoinStatus === "none"
              ? "No trace produced"
              : `${candidate.traceJoinStatus} / ${candidate.proposedTraceIds.length} trace proposal(s)`}
            {candidate.proposedQuestionType
              ? ` / runtime proposal: ${candidate.proposedQuestionType}`
              : ""}
          </div>
        </div>

        <CriticalMomentButtonGroup
          label="Eligibility"
          options={[
            ["critical", "Critical"],
            ["not-critical", "Not critical"],
            ["uncertain", "Uncertain"],
          ]}
          value={evaluation?.eligibility}
          onSelect={(eligibility) =>
            onUpdate({
              eligibility:
                eligibility as CriticalMomentEvaluation["eligibility"],
            })
          }
        />

        <div className="rounded-sm border border-border/60 p-2">
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Expected facts
          </div>
          <div className="mb-2 break-words font-mono text-[9px] text-muted-foreground">
            {groundTruth?.authority ?? "none"} /{" "}
            {groundTruth?.joinStatus ?? "missing"}
            {groundTruth?.conflictFactKinds.length
              ? ` / conflicts: ${groundTruth.conflictFactKinds.join(", ")}`
              : ""}
          </div>

          <CriticalMomentButtonGroup
            label="Runtime action"
            options={[
              ["advise", "Advise"],
              ["append-context", "Append"],
              ["buffer", "Buffer"],
              ["ignore", "Ignore"],
            ]}
            value={groundTruth?.expectedRuntimeAction}
            onSelect={(value) =>
              recordGroundTruth({
                kind: "expected-runtime-action",
                expectedAction: value as
                  | "advise"
                  | "append-context"
                  | "buffer"
                  | "ignore",
              })
            }
          />

          <div className="mt-3 space-y-2">
            <CriticalMomentButtonGroup
              label="Expected type"
              options={humanEvalQuestionTypeOptions.map((option) => [
                option.id,
                option.label,
              ])}
              value={expectedQuestionType}
              onSelect={(value) =>
                setExpectedQuestionType(
                  normalizeCanonicalQuestionType(value)
                )
              }
            />
            <CriticalMomentButtonGroup
              label="Expected relation"
              options={evaluationTaskRelations.map((value) => [
                value,
                formatEvaluationTaskRelation(value),
              ])}
              value={expectedRelation}
              onSelect={(value) => {
                const relation = normalizeEvaluationTaskRelation(value);
                setExpectedRelation(relation);
                if (relation) {
                  setExpectedParentAction((current) =>
                    current &&
                    evaluateTaskSettlementTupleCompatibilityV2({
                      relation,
                      parentAction: current,
                    }).compatible
                      ? current
                      : evaluateTaskSettlementTupleCompatibilityV2({
                          relation,
                          parentAction: "none",
                        }).recommendedParentAction
                  );
                }
              }}
            />
            <CriticalMomentButtonGroup
              label="Expected parent action"
              options={evaluationParentActions.map((value) => [
                value,
                value,
              ])}
              value={expectedParentAction}
              onSelect={(value) =>
                setExpectedParentAction(
                  evaluationParentActions.find(
                    (candidate) => candidate === value
                  )
                )
              }
            />
            {settlementCompatibility?.compatible === false ? (
              <div className="rounded-sm border border-amber-500/60 bg-amber-500/10 p-2 text-[10px]">
                <div>
                  {settlementCompatibility.reason} Choose{" "}
                  <span className="font-mono">
                    {settlementCompatibility.recommendedParentAction}
                  </span>{" "}
                  or explicitly override this tuple.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 px-2 text-[10px]"
                  onClick={() => recordTaskSettlement(true)}
                >
                  Expert override
                </Button>
              </div>
            ) : null}
            <Button
              size="sm"
              className="h-7 px-2 text-[10px]"
              disabled={
                !expectedQuestionType ||
                !expectedRelation ||
                !expectedParentAction ||
                settlementCompatibility?.compatible === false
              }
              onClick={() => recordTaskSettlement()}
            >
              Save settlement
            </Button>
          </div>

          {groundTruth?.expectedContextTurnIds.length ? (
            <div className="mt-2 break-words font-mono text-[9px] text-muted-foreground">
              Expected context:{" "}
              {groundTruth.expectedContextTurnIds.join(", ")}
            </div>
          ) : null}
          {groundTruth?.legacyExpectedAdvisorAction === "clarify" ? (
            <div className="mt-2 text-[10px] text-amber-600">
              Legacy expected action: clarify. This remains read-only because
              clarify is an advice mode, not a runtime action.
            </div>
          ) : null}
          {groundTruth?.warnings.length ? (
            <div className="mt-2 space-y-1 text-[10px] text-amber-600">
              {groundTruth.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            First useful answer
          </div>
          {traces.length ? (
            <div className="flex flex-wrap gap-1">
              {traces.map((trace) => (
                <Button
                  key={trace.id}
                  size="sm"
                  variant={
                    evaluation?.selectedUsefulTraceId === trace.id
                      ? "default"
                      : "outline"
                  }
                  className="h-6 max-w-full px-2 font-mono text-[10px]"
                  onClick={() =>
                    onUpdate({
                      traceIds: [trace.id],
                      selectedUsefulTraceId: trace.id,
                      firstUsefulAt: trace.endedAt,
                    })
                  }
                >
                  {trace.id.slice(-12)}
                </Button>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground">
              No trace is available for selection.
            </div>
          )}
        </div>

        <CriticalMomentBooleanGroup
          label="Answer outcome"
          values={[
            ["useful", "Useful", evaluation?.useful],
            ["trustworthy", "Trustworthy", evaluation?.trustworthy],
            ["naturalStart", "Natural start", evaluation?.naturalStart],
          ]}
          onUpdate={onUpdate}
        />
        <CriticalMomentBooleanGroup
          label="User behavior"
          values={[
            ["waitedForJarvis", "Waited", evaluation?.waitedForJarvis],
            ["readFromJarvis", "Read", evaluation?.readFromJarvis],
            [
              "interactionRequired",
              "Interaction",
              evaluation?.interactionRequired,
            ],
          ]}
          onUpdate={onUpdate}
        />

        <div>
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Failure reasons
          </div>
          <div className="flex flex-wrap gap-1">
            {criticalMomentFailureReasonOptions.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={
                  failureReasons.includes(option.id) ? "default" : "outline"
                }
                className="h-6 px-2 text-[10px]"
                onClick={() => toggleFailureReason(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
};

const CriticalMomentButtonGroup = ({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: Array<[string, string]>;
  value: string | undefined;
  onSelect: (value: string) => void;
}) => (
  <div>
    <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
      {label}
    </div>
    <div className="flex flex-wrap gap-1">
      {options.map(([optionValue, optionLabel]) => (
        <Button
          key={optionValue}
          size="sm"
          variant={value === optionValue ? "default" : "outline"}
          className="h-6 px-2 text-[10px]"
          onClick={() => onSelect(optionValue)}
        >
          {optionLabel}
        </Button>
      ))}
    </div>
  </div>
);

const CriticalMomentBooleanGroup = ({
  label,
  values,
  onUpdate,
}: {
  label: string;
  values: Array<
    [keyof CriticalMomentEvaluation, string, boolean | undefined]
  >;
  onUpdate: (patch: CriticalMomentOutcomeEvaluationPatch) => void;
}) => (
  <div>
    <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
      {label}
    </div>
    <div className="flex flex-wrap gap-1">
      {values.flatMap(([field, fieldLabel, fieldValue]) => [
        <Button
          key={`${String(field)}-yes`}
          size="sm"
          variant={fieldValue === true ? "default" : "outline"}
          className="h-6 px-2 text-[10px]"
          onClick={() => onUpdate({ [field]: true })}
        >
          {fieldLabel}: yes
        </Button>,
        <Button
          key={`${String(field)}-no`}
          size="sm"
          variant={fieldValue === false ? "default" : "outline"}
          className="h-6 px-2 text-[10px]"
          onClick={() => onUpdate({ [field]: false })}
        >
          {fieldLabel}: no
        </Button>,
      ])}
    </div>
  </div>
);

const evaluationTaskRelations: HumanEvaluationTaskRelation[] = [
  "none",
  "new-parent",
  "followup-parent",
  "child-probe",
  "resume-parent",
];

const evaluationParentActions: HumanExpectedParentAction[] = [
  "create",
  "preserve",
  "retype",
  "resume",
  "attach-child",
  "none",
];

const projectTrajectoryPhases: InterviewPlaybookPhase[] = [
  "project_narrative",
  "architecture_decision",
  "validation_reliability",
  "impact_lessons",
];

const projectTrajectoryFactAnchorStates: FactAnchorState[] = [
  "strong-anchor",
  "weak-anchor",
  "no-anchor",
  "not-required",
];

const projectTrajectoryChildContinuities: ProjectTrajectoryChildContinuity[] =
  ["none", "child-attached", "parent-resumed"];

function normalizeEvaluationTaskRelation(
  value: string | undefined
): HumanEvaluationTaskRelation | undefined {
  return evaluationTaskRelations.find((candidate) => candidate === value);
}

function formatEvaluationTaskRelation(
  relation: HumanEvaluationTaskRelation
) {
  return relation === "none" ? "N/A" : relation;
}

const TraceHumanEvaluationPanel = ({
  trace,
  traces,
  detectedQuestionType,
  detectedPlaybook,
  taxonomyAdjudicationCandidateType,
  taxonomyAdjudicationDisposition,
  taxonomyAdjudicationWouldRepair,
  projectionV2,
  memorySnapshot,
  preparationArtifactUses,
  preparationArtifactEvaluations,
  onUpdatePreparationArtifactEvaluation,
  evaluationPersistence,
  onRetrySave,
  onRecordGroundTruthV2,
}: {
  trace: MeetingTrace;
  traces: MeetingTrace[];
  detectedQuestionType?: string;
  detectedPlaybook?: string;
  taxonomyAdjudicationCandidateType?: string;
  taxonomyAdjudicationDisposition?: string;
  taxonomyAdjudicationWouldRepair?: boolean;
  projectionV2: HumanEvaluationProjectionV2 | undefined;
  memorySnapshot: MemoryRetrievalEvaluationSnapshotResolution;
  preparationArtifactUses: PreparationArtifactUseReceipt[];
  preparationArtifactEvaluations: PreparationArtifactEvaluation[];
  onUpdatePreparationArtifactEvaluation: (receiptId: string, label: PreparationArtifactEvaluationLabel) => void;
  evaluationPersistence: { pending: number; error: string | null };
  onRetrySave: () => void;
  onRecordGroundTruthV2: (
    fact: HumanGroundTruthFactV2,
    options?: {
      actionId?: string;
      confirmation?: "confirmed" | "suggested";
      interaction?: HumanGroundTruthInteractionV2;
    }
  ) => void;
}) => {
  const [draftFailureReasons, setDraftFailureReasons] = useState<string[]>();
  const [missingMemoryId, setMissingMemoryId] = useState("");
  const [taskFixOpen, setTaskFixOpen] = useState(false);
  const [primaryAskFixOpen, setPrimaryAskFixOpen] = useState(false);
  const [primaryAskCorrection, setPrimaryAskCorrection] = useState("");
  const [expectedQuestionType, setExpectedQuestionType] =
    useState<CanonicalQuestionType>();
  const [expectedRelation, setExpectedRelation] =
    useState<HumanEvaluationTaskRelation>();
  const [expectedParentAction, setExpectedParentAction] =
    useState<HumanExpectedParentAction>();
  const [projectTrajectoryFixOpen, setProjectTrajectoryFixOpen] =
    useState(false);
  const [meetingMetadataFixOpen, setMeetingMetadataFixOpen] = useState(false);
  const [sourceMeetingCompany, setSourceMeetingCompany] = useState("");
  const [expectedEffectiveMeetingCompany, setExpectedEffectiveMeetingCompany] =
    useState("");
  const [expectedMeetingMetadataMutation, setExpectedMeetingMetadataMutation] =
    useState<MeetingMetadataMutationDisposition>();
  const [meetingMetadataErrorKind, setMeetingMetadataErrorKind] =
    useState<MeetingMetadataEvaluationErrorKind>();
  const [expectedProjectName, setExpectedProjectName] = useState("");
  const [expectedProjectPhase, setExpectedProjectPhase] =
    useState<InterviewPlaybookPhase>();
  const [expectedProjectFactAnchorState, setExpectedProjectFactAnchorState] =
    useState<FactAnchorState>();
  const [expectedProjectChildContinuity, setExpectedProjectChildContinuity] =
    useState<ProjectTrajectoryChildContinuity>();
  const [
    expectedUnsupportedFirstPersonClaim,
    setExpectedUnsupportedFirstPersonClaim,
  ] = useState<boolean>();
  const evaluationOpenedAtRef = useRef<number | undefined>(undefined);
  const evaluationClickCountRef = useRef(0);
  const expandedEvaluationRegionsRef = useRef(new Set<string>());
  const primaryAskNormalizedText =
    projectionV2?.observed?.primaryAsk ??
    (typeof trace.metadata?.primaryAskNormalizedText === "string"
      ? trace.metadata.primaryAskNormalizedText
      : undefined);
  const primaryAskTargetSource =
    projectionV2?.observed?.primaryAskTargetSource ??
    "unavailable";
  const currentQuestionSettlementDisposition =
    typeof trace.metadata?.currentQuestionSettlementDisposition === "string"
      ? trace.metadata.currentQuestionSettlementDisposition
      : undefined;
  const observedSnapshotV2 = buildHumanEvaluationAttemptEvidenceV2({
    trace,
    traces,
  }).observed;
  const questionTypeObservation = projectQuestionTypeObservation({
    metadata: trace.metadata,
    fallbackCurrentQuestionType: detectedQuestionType,
  });
  const observedQuestionType =
    observedSnapshotV2.observedCurrentQuestionType ??
    observedSnapshotV2.questionType;
  const observedRelation = observedSnapshotV2.relation;
  const observedParentAction = observedSnapshotV2.parentAction;
  const expectedSettlementCompatibility =
    expectedRelation && expectedParentAction
      ? evaluateTaskSettlementTupleCompatibilityV2({
          relation: expectedRelation,
          parentAction: expectedParentAction,
        })
      : undefined;
  const observedSettlementCompatibility =
    observedRelation && observedParentAction
      ? evaluateTaskSettlementTupleCompatibilityV2({
          relation: observedRelation,
          parentAction: observedParentAction,
        })
      : undefined;
  const activeRuntimeFact =
    projectionV2?.activeFacts["expected-runtime-action"]?.fact;
  const activeSettlementFact =
    projectionV2?.activeFacts["expected-task-settlement"]?.fact;
  const activeAnswerFact =
    projectionV2?.activeFacts["answer-quality"]?.fact;
  const answerFailureReasons = draftFailureReasons ??
    (activeAnswerFact?.kind === "answer-quality" ? activeAnswerFact.failureReasons : []);
  const activeContextReadScopeFact =
    projectionV2?.activeFacts["expected-context-read-scope"]?.fact;
  const activeArtifactIntentFact =
    projectionV2?.activeFacts["expected-artifact-intent"]?.fact;
  const activeProjectTrajectoryFact =
    projectionV2?.activeFacts["expected-project-trajectory"]?.fact;
  const activeMeetingMetadataFact =
    projectionV2?.activeFacts["expected-meeting-metadata"]?.fact;
  const observedMeetingMetadata =
    observedSnapshotV2.meetingMetadata ??
    projectMeetingMetadataEvaluationObservation(trace.metadata ?? {});
  const showMeetingMetadataEvaluation =
    observedMeetingMetadata.operationObserved;
  const observedProjectId = observedSnapshotV2.projectId;
  const observedProjectName = observedSnapshotV2.projectName;
  const observedProjectBindingRevision =
    observedSnapshotV2.projectBindingRevision;
  const observedProjectPhase = observedSnapshotV2.playbookPhase;
  const observedProjectFactAnchorState =
    observedSnapshotV2.factAnchorState;
  const observedProjectChildContinuity =
    observedSnapshotV2.childContinuity;
  const showProjectTrajectoryEvaluation =
    observedQuestionType === "project-deep-dive" ||
    detectedQuestionType === "project-deep-dive" ||
    detectedPlaybook === "project_deep_dive" ||
    Boolean(observedProjectId || observedProjectName);
  const observedContextReadScope = observedSnapshotV2.contextReadScope;
  const observedArtifactIntent = observedSnapshotV2.artifactIntent;
  const observedRuntimeAction = observedSnapshotV2.runtimeAction;

  const recordGroundTruth = (
    fact: HumanGroundTruthFactV2,
    options?: {
      actionId?: string;
      confirmation?: "confirmed" | "suggested";
    }
  ) => {
    const now = Date.now();
    const startedAt = evaluationOpenedAtRef.current ?? now;
    evaluationOpenedAtRef.current = startedAt;
    onRecordGroundTruthV2(fact, {
      ...options,
      interaction: {
        startedAt,
        durationMs: now - startedAt,
        clickCount: evaluationClickCountRef.current,
        expandedRegions: Array.from(
          expandedEvaluationRegionsRef.current
        ).sort(),
      },
    });
  };

  const recordExpectedRuntimeAction = (
    expectedAction: "advise" | "append-context" | "buffer" | "ignore"
  ) => {
    recordGroundTruth({
      kind: "expected-runtime-action",
      expectedAction,
    });
  };

  const recordExpectedContextReadScope = (
    expectedScope:
      | "current-only"
      | "active-parent-read"
      | "active-child-read"
      | "bounded-recent-history"
  ) => {
    recordGroundTruth({
      kind: "expected-context-read-scope",
      expectedScope,
    });
  };

  const recordExpectedArtifactIntent = (
    expectedIntent:
      | "none"
      | "preserve"
      | "revise-code"
      | "revise-whiteboard"
  ) => {
    recordGroundTruth({
      kind: "expected-artifact-intent",
      expectedIntent,
    });
  };

  const recordExpectedProjectTrajectory = (
    fact: Extract<
      HumanGroundTruthFactV2,
      { kind: "expected-project-trajectory" }
    >
  ) => {
    recordGroundTruth(fact);
  };

  const recordExpectedMeetingMetadata = (input: {
    sourceCompany: string | null;
    expectedEffectiveCompany: string | null;
    expectedMutationDisposition: MeetingMetadataMutationDisposition;
    errorKind?: MeetingMetadataEvaluationErrorKind;
  }) => {
    recordGroundTruth({
      kind: "expected-meeting-metadata",
      sourceCompany: input.sourceCompany,
      expectedEffectiveCompany: input.expectedEffectiveCompany,
      expectedMutationDisposition: input.expectedMutationDisposition,
      errorKind: input.errorKind,
    });
    setMeetingMetadataFixOpen(false);
  };

  const recordObservedProjectTrajectory = () => {
    recordExpectedProjectTrajectory({
      kind: "expected-project-trajectory",
      expectedProjectId: observedProjectId,
      expectedProjectName: observedProjectName,
      expectedPhase: observedProjectPhase,
      expectedFactAnchorState: observedProjectFactAnchorState,
      expectedChildContinuity: observedProjectChildContinuity,
    });
  };

  const saveCorrectedProjectTrajectory = () => {
    recordExpectedProjectTrajectory({
      kind: "expected-project-trajectory",
      expectedProjectName: expectedProjectName.trim() || undefined,
      expectedPhase: expectedProjectPhase,
      expectedFactAnchorState: expectedProjectFactAnchorState,
      expectedChildContinuity: expectedProjectChildContinuity,
      unsupportedFirstPersonClaim:
        expectedUnsupportedFirstPersonClaim,
    });
    setProjectTrajectoryFixOpen(false);
  };

  const recordObservedTaskSettlement = () => {
    if (!observedQuestionType || !observedRelation || !observedParentAction) {
      setTaskFixOpen(true);
      return;
    }
    if (observedSettlementCompatibility?.compatible === false) {
      setExpectedQuestionType(observedQuestionType);
      setExpectedRelation(observedRelation);
      setExpectedParentAction(observedParentAction);
      setTaskFixOpen(true);
      return;
    }
    recordGroundTruth({
      kind: "expected-task-settlement",
      expectedQuestionType: observedQuestionType,
      expectedRelation: observedRelation,
      expectedParentAction: observedParentAction,
      ...freezeObservedTaskOwnerIdentityV2(observedSnapshotV2),
    });
    setTaskFixOpen(false);
  };

  const recordCorrectedTaskSettlement = (
    allowIncompatibleTuple = false
  ) => {
    if (!expectedQuestionType || !expectedRelation || !expectedParentAction) {
      return;
    }
    if (
      expectedSettlementCompatibility?.compatible === false &&
      !allowIncompatibleTuple
    ) {
      return;
    }
    recordGroundTruth({
      kind: "expected-task-settlement",
      expectedQuestionType,
      expectedRelation,
      expectedParentAction,
    }, {
      actionId: allowIncompatibleTuple
        ? `task-settlement-tuple-override:${trace.id}:${Date.now()}`
        : undefined,
      confirmation: "confirmed",
    });
    setTaskFixOpen(false);
  };

  const recordAnswerOutcome = (
    outcome: "useful" | "partial" | "wrong" | "no-answer"
  ) => {
    recordGroundTruth({
      kind: "answer-quality",
      outcome,
      failureReasons: answerFailureReasons,
      expectedContextTurnIds:
        activeAnswerFact?.kind === "answer-quality"
          ? activeAnswerFact.expectedContextTurnIds
          : [],
    });
  };

  const savePrimaryAskCorrection = () => {
    const correctedPrimaryAsk = primaryAskCorrection.trim();
    if (!correctedPrimaryAsk || correctedPrimaryAsk === primaryAskNormalizedText?.trim()) return;
    recordGroundTruth({
      kind: "primary-ask-correction",
      correctedPrimaryAsk,
    });
    setPrimaryAskFixOpen(false);
  };

  return (
    <div className="space-y-3">
      {evaluationPersistence.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[10px] text-destructive">
          <span className="min-w-0 break-words">Human evaluation not saved: {evaluationPersistence.error}</span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={onRetrySave}>
            Retry save
          </Button>
        </div>
      ) : evaluationPersistence.pending > 0 ? (
        <div role="status" className="text-[10px] text-muted-foreground">
          Saving human evaluation ({evaluationPersistence.pending})...
        </div>
      ) : null}
      {taxonomyAdjudicationDisposition ? (
        <div className="rounded-sm border border-border/60 bg-muted/30 p-2 text-[10px]">
          <div className="font-medium uppercase text-muted-foreground">
            Runtime type adjudication
          </div>
          <div className="mt-1 break-words">
            {taxonomyAdjudicationCandidateType ?? "No valid proposal"}
            {` / ${taxonomyAdjudicationDisposition}`}
            {taxonomyAdjudicationWouldRepair === true ? " / would repair" : ""}
          </div>
        </div>
      ) : null}
    <details
      className="mt-2 border-t border-border/50 pt-2"
      onClickCapture={() => {
        evaluationOpenedAtRef.current ??= Date.now();
        evaluationClickCountRef.current += 1;
      }}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          evaluationOpenedAtRef.current ??= Date.now();
          expandedEvaluationRegionsRef.current.add("human-evaluation");
        } else {
          expandedEvaluationRegionsRef.current.delete("human-evaluation");
        }
      }}
    >
      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
        Human evaluation
      </summary>
      <div className="mt-2 space-y-3">
<div data-evaluation-group="response-opportunity" className="rounded-sm border border-border/60 p-2">
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Response Opportunity
          </div>
          <div className="mb-2 font-mono text-[9px] text-muted-foreground">
            observed:{" "}
            {observedRuntimeAction ?? "unknown"}
          </div>
          <div className="mb-2 space-y-1 text-[10px]">
            <div className="text-muted-foreground">Primary Ask / {primaryAskTargetSource}</div>
            <div className="whitespace-pre-wrap break-words">{primaryAskNormalizedText ?? "Unavailable"}</div>
            {projectionV2?.activeFacts["primary-ask-correction"]?.fact.kind === "primary-ask-correction" ? (
              <div className="whitespace-pre-wrap break-words">
                Correction: {projectionV2.activeFacts["primary-ask-correction"].fact.correctedPrimaryAsk}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["advise", "Advise"],
                ["append-context", "Append"],
                ["buffer", "Buffer"],
                ["ignore", "Ignore"],
              ] as const
            ).map(([action, label]) => (
              <Button
                key={action}
                size="sm"
                variant={
                  activeRuntimeFact?.kind === "expected-runtime-action" &&
                  activeRuntimeFact.expectedAction === action
                    ? "default"
                    : "outline"
                }
                className="h-7 px-2 text-[10px]"
                onClick={() => recordExpectedRuntimeAction(action)}
              >
                {label}
              </Button>
            ))}
            <Button
              size="sm"
              variant={primaryAskFixOpen ? "default" : "outline"}
              className="h-7 px-2 text-[10px]"
              onClick={() => {
                setPrimaryAskCorrection(primaryAskNormalizedText ?? "");
                setPrimaryAskFixOpen((open) => !open);
              }}
            >
              Correct primary ask
            </Button>
          </div>
          {primaryAskFixOpen ? (
            <div className="mt-2 flex gap-1">
              <Textarea
                value={primaryAskCorrection}
                onChange={(event) =>
                  setPrimaryAskCorrection(event.target.value)
                }
                placeholder="Correct primary ask"
                className="min-h-12 text-[10px]"
              />
              <Button
                size="sm"
                className="h-8 shrink-0 px-2 text-[10px]"
                disabled={!primaryAskCorrection.trim() || primaryAskCorrection.trim() === primaryAskNormalizedText?.trim()}
                onClick={savePrimaryAskCorrection}
              >
                Save
              </Button>
            </div>
          ) : null}
        </div>


<div data-evaluation-group="task-settlement" className="rounded-sm border border-border/60 p-2">
          <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
            Task settlement
          </div>
          <div className="space-y-0.5 break-words font-mono text-[9px] text-muted-foreground">
            <div>
              current question: {observedQuestionType ?? "unknown"}
              {questionTypeObservation.observedCurrentQuestionTypeAuthority
                ? ` (${questionTypeObservation.observedCurrentQuestionTypeAuthority})`
                : ""}
            </div>
            <div>
              durable parent:{" "}
              {questionTypeObservation.observedParentType ?? "none"}
              {questionTypeObservation.observedParentId
                ? ` (${questionTypeObservation.observedParentId})`
                : ""}
            </div>
            <div>
              settlement:{" "}
              {observedRelation
                ? formatEvaluationTaskRelation(observedRelation)
                : trace.status === "success"
                  ? "ERROR: unresolved relation"
                  : "N/A"}{" "}
              /{" "}
              {observedParentAction ??
                (trace.status === "success"
                  ? "ERROR: unresolved action"
                  : "N/A")}
            </div>
            <div>
              execution: {currentQuestionSettlementDisposition ?? "N/A"}
              {typeof trace.metadata?.responseOnlyRelationDisposition ===
              "string"
                ? ` / ${trace.metadata.responseOnlyRelationDisposition}`
                : ""}
              {typeof trace.metadata?.responseOnlyContextReadScope === "string"
                ? ` / ${trace.metadata.responseOnlyContextReadScope}`
                : ""}
            </div>
            {observedRelation === "none" ? (
              <div>
                Answer-only / no lifecycle action
                {typeof trace.metadata?.taskRelationOrderedResolutionReason === "string"
                  ? `: ${trace.metadata.taskRelationOrderedResolutionReason}` : ""}
              </div>
            ) : null}
            <div>parent owner: {observedSnapshotV2.settledParentId ?? "none"}</div>
            <div>branch owner: {observedSnapshotV2.settledBranchId ?? "none"}</div>
            <div>context owner: {observedSnapshotV2.contextOwnerId ?? "none"}</div>
            <div>
              applied: response{" "}
              {formatObservedBoolean(
                questionTypeObservation.typeAppliedToResponse
              )}
              {" / settlement "}
              {formatObservedBoolean(
                questionTypeObservation.typeAppliedToSettlement
              )}
              {" / parent "}
              {formatObservedBoolean(
                questionTypeObservation.typeAppliedToParent
              )}
            </div>
            {questionTypeObservation.durableOwnerMissing ? (
              <div className="text-amber-700 dark:text-amber-300">
                durable owner missing:{" "}
                {questionTypeObservation.durableOwnerMissingReason ??
                  "unresolved"}
              </div>
            ) : null}
          </div>
          {activeSettlementFact?.kind ===
          "expected-task-settlement" ? (
            <div className="mt-1 break-words font-mono text-[9px]">
              expected: {activeSettlementFact.expectedQuestionType} /{" "}
              {activeSettlementFact.expectedRelation} /{" "}
              {activeSettlementFact.expectedParentAction}
            </div>
          ) : null}
          <div className="mt-2 flex gap-1">
            <Button
              size="sm"
              variant={
                projectionV2?.verdicts.taskSettlementCorrect === true
                  ? "default"
                  : "outline"
              }
              className="h-7 px-2 text-[10px]"
              onClick={recordObservedTaskSettlement}
            >
              Correct
            </Button>
            <Button
              size="sm"
              variant={taskFixOpen ? "default" : "outline"}
              className="h-7 px-2 text-[10px]"
              onClick={() => {
                setExpectedQuestionType(
                  observedQuestionType
                );
                setExpectedRelation(observedRelation);
                setExpectedParentAction(
                  observedParentAction
                );
                setTaskFixOpen((open) => !open);
              }}
            >
              Fix
            </Button>
          </div>
          {taskFixOpen ? (
            <div className="mt-2 space-y-2 rounded-sm bg-muted/30 p-2">
              <CriticalMomentButtonGroup
                label="Expected type"
                options={humanEvalQuestionTypeOptions.map((option) => [
                  option.id,
                  option.label,
                ])}
                value={expectedQuestionType}
                onSelect={(value) =>
                  setExpectedQuestionType(
                    normalizeCanonicalQuestionType(value)
                  )
                }
              />
              <CriticalMomentButtonGroup
                label="Expected relation"
                options={evaluationTaskRelations.map((value) => [
                  value,
                  formatEvaluationTaskRelation(value),
                ])}
                value={expectedRelation}
                onSelect={(value) => {
                  const relation =
                    normalizeEvaluationTaskRelation(value);
                  setExpectedRelation(relation);
                }}
              />
              <CriticalMomentButtonGroup
                label="Expected parent action"
                options={evaluationParentActions.map((value) => [
                  value,
                  value,
                ])}
                value={expectedParentAction}
                onSelect={(value) =>
                  setExpectedParentAction(
                    evaluationParentActions.find(
                      (candidate) => candidate === value
                    )
                  )
                }
              />
              {expectedSettlementCompatibility?.compatible === false ? (
                <div className="rounded-sm border border-amber-500/60 bg-amber-500/10 p-2 text-[10px]">
                  <div>
                    {expectedSettlementCompatibility.reason} Choose{" "}
                    <span className="font-mono">
                      {
                        expectedSettlementCompatibility.recommendedParentAction
                      }
                    </span>{" "}
                    or explicitly override this tuple.
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7 px-2 text-[10px]"
                    onClick={() =>
                      recordCorrectedTaskSettlement(true)
                    }
                  >
                    Expert override
                  </Button>
                </div>
              ) : null}
              <Button
                size="sm"
                className="h-7 px-2 text-[10px]"
                disabled={
                  !expectedQuestionType ||
                  !expectedRelation ||
                  !expectedParentAction ||
                  expectedSettlementCompatibility?.compatible === false
                }
                onClick={() => recordCorrectedTaskSettlement()}
              >
                Save settlement
              </Button>
            </div>
          ) : null}
        </div>

<div data-evaluation-group="answer-quality" className="rounded-sm border border-border/60 p-2">
          <div className="mb-2 text-[10px] font-medium uppercase text-muted-foreground">
            Answer Quality
          </div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["useful", "Useful"],
                ["partial", "Partial"],
                ["wrong", "Wrong"],
                ["no-answer", "No answer"],
              ] as const
            ).map(([outcome, label]) => (
              <Button
                key={outcome}
                size="sm"
                variant={
                  activeAnswerFact?.kind === "answer-quality" &&
                  activeAnswerFact.outcome === outcome
                    ? "default"
                    : "outline"
                }
                className="h-7 px-2 text-[10px]"
                onClick={() => recordAnswerOutcome(outcome)}
              >
                {label}
              </Button>
            ))}
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">Failure reasons</summary>
            <div className="mt-1 flex flex-wrap gap-2">
              {humanEvalFailureReasonOptions.map((option) => (
                <label key={option.id} className="flex items-center gap-1 text-[10px]">
                  <input
                    type="checkbox"
                    checked={answerFailureReasons.includes(option.id)}
                    onChange={(event) => {
                      const reasons = event.target.checked
                        ? [...answerFailureReasons, option.id]
                        : answerFailureReasons.filter((reason) => reason !== option.id);
                      setDraftFailureReasons(reasons);
                      if (activeAnswerFact?.kind === "answer-quality") {
                        recordGroundTruth({ ...activeAnswerFact, failureReasons: reasons });
                      }
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </details>
        </div>

        {projectionV2?.conflicts.length ? (
          <div className="rounded-sm border border-amber-500/60 bg-amber-500/10 p-2 text-[10px]">
            Conflicting human labels need review (
            {projectionV2.conflicts.length}).
          </div>
        ) : null}

        <details
          className="border-t border-border/50 pt-2"
          onToggle={(event) => {
            if (event.currentTarget.open) {
              expandedEvaluationRegionsRef.current.add("expert-audit");
            } else {
              expandedEvaluationRegionsRef.current.delete("expert-audit");
            }
          }}
        >
          <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
            Expert audit
          </summary>
          <div className="mt-2 space-y-2">
        {showMeetingMetadataEvaluation ? (
<div data-evaluation-group="metadata" className="rounded-sm border border-border/60 p-2">
            <div className="text-[10px] font-medium uppercase text-muted-foreground">
              Meeting metadata
            </div>
            <div className="mt-1 space-y-0.5 break-words font-mono text-[9px] text-muted-foreground">
              <div>
                proposal: {observedMeetingMetadata.proposalCompany ?? "unknown"}
              </div>
              <div>
                effective: {observedMeetingMetadata.effectiveCompany ?? "unknown"}
                {observedMeetingMetadata.authoritySource
                  ? ` (${observedMeetingMetadata.authoritySource})`
                  : ""}
              </div>
              <div>
                disposition: {observedMeetingMetadata.disposition ?? "unknown"}
                {observedMeetingMetadata.comparisonDisposition
                  ? ` / ${observedMeetingMetadata.comparisonDisposition}`
                  : ""}
              </div>
              <div>
                mutation: {observedMeetingMetadata.mutationOutcome}
                {observedMeetingMetadata.mutationDisposition
                  ? ` (${observedMeetingMetadata.mutationDisposition})`
                  : ""}
              </div>
              <div>
                applied: {formatObservedBoolean(
                  observedMeetingMetadata.appliedToRuntime
                )}
                {observedMeetingMetadata.overrideOccurred
                  ? " / authority override detected"
                  : ""}
              </div>
            </div>
            {activeMeetingMetadataFact?.kind ===
            "expected-meeting-metadata" ? (
              <div className="mt-1 space-y-0.5 break-words font-mono text-[9px]">
                <div>
                  source truth: {activeMeetingMetadataFact.sourceCompany ??
                    "none"}
                </div>
                <div>
                  expected effective: {activeMeetingMetadataFact
                    .expectedEffectiveCompany ?? "none"}
                </div>
                <div>
                  expected mutation: {activeMeetingMetadataFact
                    .expectedMutationDisposition ?? "unlabeled"}
                </div>
                {activeMeetingMetadataFact.errorKind ? (
                  <div>failure: {activeMeetingMetadataFact.errorKind}</div>
                ) : null}
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              <Button
                size="sm"
                variant={
                  projectionV2?.verdicts.meetingMetadataProposalCorrect ===
                    true &&
                  projectionV2?.verdicts.meetingMetadataTargetCorrect ===
                    true &&
                  projectionV2?.verdicts.meetingMetadataMutationCorrect ===
                    true
                    ? "default"
                    : "outline"
                }
                className="h-6 px-2 text-[9px]"
                disabled={!observedMeetingMetadata.proposalCompany || !observedMeetingMetadata.effectiveCompany}
                onClick={() => {
                  if (!observedMeetingMetadata.proposalCompany || !observedMeetingMetadata.effectiveCompany) return;
                  recordExpectedMeetingMetadata({
                    sourceCompany: observedMeetingMetadata.proposalCompany,
                    expectedEffectiveCompany: observedMeetingMetadata.effectiveCompany,
                    expectedMutationDisposition:
                      observedMeetingMetadata.mutationOutcome,
                  });
                }}
              >
                Correct
              </Button>
              <Button
                size="sm"
                variant={
                  activeMeetingMetadataFact?.kind ===
                    "expected-meeting-metadata" &&
                  activeMeetingMetadataFact.sourceCompany === null
                    ? "default"
                    : "outline"
                }
                className="h-6 px-2 text-[9px]"
                onClick={() => {
                  setSourceMeetingCompany("");
                  setExpectedEffectiveMeetingCompany(
                    activeMeetingMetadataFact?.kind ===
                    "expected-meeting-metadata"
                      ? activeMeetingMetadataFact.expectedEffectiveCompany ?? ""
                      : observedMeetingMetadata.effectiveCompany ?? ""
                  );
                  setExpectedMeetingMetadataMutation(
                    activeMeetingMetadataFact?.kind ===
                      "expected-meeting-metadata" &&
                    activeMeetingMetadataFact.expectedMutationDisposition
                      ? activeMeetingMetadataFact.expectedMutationDisposition
                      : observedMeetingMetadata.mutationOutcome
                  );
                  setMeetingMetadataFixOpen(true);
                }}
              >
                No source company
              </Button>
              <Button
                size="sm"
                variant={meetingMetadataFixOpen ? "default" : "outline"}
                className="h-6 px-2 text-[9px]"
                onClick={() => {
                  setSourceMeetingCompany(
                    activeMeetingMetadataFact?.kind ===
                    "expected-meeting-metadata"
                      ? activeMeetingMetadataFact.sourceCompany ?? ""
                      : observedMeetingMetadata.proposalCompany ?? ""
                  );
                  setExpectedEffectiveMeetingCompany(
                    activeMeetingMetadataFact?.kind ===
                    "expected-meeting-metadata"
                      ? activeMeetingMetadataFact.expectedEffectiveCompany ?? ""
                      : observedMeetingMetadata.effectiveCompany ?? ""
                  );
                  setExpectedMeetingMetadataMutation(
                    activeMeetingMetadataFact?.kind ===
                      "expected-meeting-metadata" &&
                    activeMeetingMetadataFact.expectedMutationDisposition
                      ? activeMeetingMetadataFact.expectedMutationDisposition
                      : observedMeetingMetadata.mutationOutcome
                  );
                  setMeetingMetadataErrorKind(
                    activeMeetingMetadataFact?.kind ===
                      "expected-meeting-metadata"
                      ? activeMeetingMetadataFact.errorKind
                      : undefined
                  );
                  setMeetingMetadataFixOpen((open) => !open);
                }}
              >
                Fix
              </Button>
            </div>
            {meetingMetadataFixOpen ? (
              <div className="mt-2 space-y-2 rounded-sm bg-muted/30 p-2">
                <Input
                  value={sourceMeetingCompany}
                  onChange={(event) =>
                    setSourceMeetingCompany(event.target.value)
                  }
                  placeholder="Source company truth (blank = none)"
                  className="h-7 text-[10px]"
                />
                <Input
                  value={expectedEffectiveMeetingCompany}
                  onChange={(event) =>
                    setExpectedEffectiveMeetingCompany(event.target.value)
                  }
                  placeholder="Expected effective company (blank = none)"
                  className="h-7 text-[10px]"
                />
                <CriticalMomentButtonGroup
                  label="Expected mutation"
                  options={[
                    ["commit", "Commit"],
                    ["preserve", "Preserve"],
                    ["abstain", "Abstain"],
                  ]}
                  value={expectedMeetingMetadataMutation}
                  onSelect={(value) =>
                    setExpectedMeetingMetadataMutation(
                      value as MeetingMetadataMutationDisposition
                    )
                  }
                />
                <CriticalMomentButtonGroup
                  label="Failure kind"
                  options={[
                    ["missed-target-company", "Missed"],
                    ["wrong-target-company", "Wrong"],
                    ["comparison-as-target", "Comparison"],
                    ["candidate-history-as-target", "Candidate history"],
                    ["location-as-target", "Location"],
                    ["product-as-target", "Product"],
                    ["locked-brief-overridden", "Brief override"],
                    ["other", "Other"],
                  ]}
                  value={meetingMetadataErrorKind}
                  onSelect={(value) =>
                    setMeetingMetadataErrorKind(
                      value as MeetingMetadataEvaluationErrorKind
                    )
                  }
                />
                <Button
                  size="sm"
                  className="h-6 px-2 text-[9px]"
                  disabled={!expectedMeetingMetadataMutation}
                  onClick={() =>
                    expectedMeetingMetadataMutation &&
                    recordExpectedMeetingMetadata({
                      sourceCompany:
                        sourceMeetingCompany.trim() || null,
                      expectedEffectiveCompany:
                        expectedEffectiveMeetingCompany.trim() || null,
                      expectedMutationDisposition:
                        expectedMeetingMetadataMutation,
                      errorKind: meetingMetadataErrorKind,
                    })
                  }
                >
                  Save metadata labels
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
<div data-evaluation-group="context" className="rounded-sm border border-border/60 p-2">
          <div className="text-[10px] font-medium uppercase text-muted-foreground">
            Context read scope
          </div>
          <div className="mt-1 font-mono text-[9px] text-muted-foreground">
            observed: {observedContextReadScope ?? "unknown"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {(
              [
                ["current-only", "Current"],
                ["active-parent-read", "Parent"],
                ["active-child-read", "Child"],
                ["bounded-recent-history", "Recent"],
              ] as const
            ).map(([scope, label]) => (
              <Button
                key={scope}
                size="sm"
                variant={
                  activeContextReadScopeFact?.kind ===
                    "expected-context-read-scope" &&
                  activeContextReadScopeFact.expectedScope === scope
                    ? "default"
                    : "outline"
                }
                className="h-6 px-2 text-[9px]"
                onClick={() => recordExpectedContextReadScope(scope)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
<div data-evaluation-group="artifact-intent" className="rounded-sm border border-border/60 p-2">
          <div className="text-[10px] font-medium uppercase text-muted-foreground">
            Artifact intent
          </div>
          <div className="mt-1 font-mono text-[9px] text-muted-foreground">
            observed: {observedArtifactIntent ?? "unknown"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {(
              [
                ["none", "None"],
                ["preserve", "Preserve"],
                ["revise-code", "Code"],
                ["revise-whiteboard", "Whiteboard"],
              ] as const
            ).map(([intent, label]) => (
              <Button
                key={intent}
                size="sm"
                variant={
                  activeArtifactIntentFact?.kind ===
                    "expected-artifact-intent" &&
                  activeArtifactIntentFact.expectedIntent === intent
                    ? "default"
                    : "outline"
                }
                className="h-6 px-2 text-[9px]"
                onClick={() => recordExpectedArtifactIntent(intent)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        {showProjectTrajectoryEvaluation ? (
<div data-evaluation-group="project" className="rounded-sm border border-border/60 p-2">
            <div className="text-[10px] font-medium uppercase text-muted-foreground">
              Project trajectory
            </div>
            <div className="mt-1 break-words font-mono text-[9px] text-muted-foreground">
              observed: {observedProjectName ?? observedProjectId ?? "unbound"}
              {observedProjectBindingRevision !== undefined
                ? `@${observedProjectBindingRevision}`
                : ""}
              {" / "}
              {observedProjectPhase ?? "phase-unknown"}
              {" / "}
              {observedProjectFactAnchorState ?? "fact-unknown"}
              {" / "}
              {observedProjectChildContinuity ?? "continuity-unknown"}
            </div>
            {activeProjectTrajectoryFact?.kind ===
            "expected-project-trajectory" ? (
              <div className="mt-1 break-words font-mono text-[9px]">
                expected:{" "}
                {activeProjectTrajectoryFact.expectedProjectName ??
                  activeProjectTrajectoryFact.expectedProjectId ??
                  "unspecified"}
                {" / "}
                {activeProjectTrajectoryFact.expectedPhase ??
                  "phase-unspecified"}
                {" / "}
                {activeProjectTrajectoryFact.expectedFactAnchorState ??
                  "fact-unspecified"}
                {" / "}
                {activeProjectTrajectoryFact.expectedChildContinuity ??
                  "continuity-unspecified"}
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              <Button
                size="sm"
                variant={
                  projectionV2?.verdicts.projectCorrect === true &&
                  projectionV2.verdicts.playbookPhaseCorrect !== false &&
                  projectionV2.verdicts.factSupportCorrect !== false &&
                  projectionV2.verdicts.childContinuityCorrect !== false
                    ? "default"
                    : "outline"
                }
                className="h-6 px-2 text-[9px]"
                disabled={
                  !observedProjectId &&
                  !observedProjectName &&
                  !observedProjectPhase &&
                  !observedProjectFactAnchorState
                }
                onClick={recordObservedProjectTrajectory}
              >
                Correct
              </Button>
              <Button
                size="sm"
                variant={projectTrajectoryFixOpen ? "default" : "outline"}
                className="h-6 px-2 text-[9px]"
                onClick={() => {
                  const activeFact =
                    activeProjectTrajectoryFact?.kind ===
                    "expected-project-trajectory"
                      ? activeProjectTrajectoryFact
                      : undefined;
                  setExpectedProjectName(
                    activeFact?.expectedProjectName ??
                      activeFact?.expectedProjectId ??
                      observedProjectName ??
                      observedProjectId ??
                      ""
                  );
                  setExpectedProjectPhase(
                    activeFact?.expectedPhase ?? observedProjectPhase
                  );
                  setExpectedProjectFactAnchorState(
                    activeFact?.expectedFactAnchorState ??
                      observedProjectFactAnchorState
                  );
                  setExpectedProjectChildContinuity(
                    activeFact?.expectedChildContinuity ??
                      observedProjectChildContinuity
                  );
                  setExpectedUnsupportedFirstPersonClaim(
                    activeFact?.unsupportedFirstPersonClaim
                  );
                  setProjectTrajectoryFixOpen((open) => !open);
                }}
              >
                Fix
              </Button>
            </div>
            {projectTrajectoryFixOpen ? (
              <div className="mt-2 space-y-2 rounded-sm bg-muted/30 p-2">
                <Label className="text-[9px] text-muted-foreground">
                  Expected project
                </Label>
                <Input
                  value={expectedProjectName}
                  onChange={(event) =>
                    setExpectedProjectName(event.target.value)
                  }
                  placeholder="Project id or name"
                  className="h-7 text-[10px]"
                />
                <CriticalMomentButtonGroup
                  label="Expected phase"
                  options={projectTrajectoryPhases.map((phase) => [
                    phase,
                    phase,
                  ])}
                  value={expectedProjectPhase}
                  onSelect={(value) =>
                    setExpectedProjectPhase(
                      projectTrajectoryPhases.find(
                        (phase) => phase === value
                      )
                    )
                  }
                />
                <CriticalMomentButtonGroup
                  label="Expected fact support"
                  options={projectTrajectoryFactAnchorStates.map(
                    (state) => [state, state]
                  )}
                  value={expectedProjectFactAnchorState}
                  onSelect={(value) =>
                    setExpectedProjectFactAnchorState(
                      projectTrajectoryFactAnchorStates.find(
                        (state) => state === value
                      )
                    )
                  }
                />
                <CriticalMomentButtonGroup
                  label="Expected child/resume"
                  options={projectTrajectoryChildContinuities.map(
                    (continuity) => [continuity, continuity]
                  )}
                  value={expectedProjectChildContinuity}
                  onSelect={(value) =>
                    setExpectedProjectChildContinuity(
                      projectTrajectoryChildContinuities.find(
                        (continuity) => continuity === value
                      )
                    )
                  }
                />
                <div>
                  <div className="mb-1 text-[9px] text-muted-foreground">
                    Unsupported first-person claim
                  </div>
                  <div className="flex gap-1">
                    {[false, true].map((value) => (
                      <Button
                        key={String(value)}
                        size="sm"
                        variant={
                          expectedUnsupportedFirstPersonClaim === value
                            ? "default"
                            : "outline"
                        }
                        className="h-6 px-2 text-[9px]"
                        onClick={() =>
                          setExpectedUnsupportedFirstPersonClaim(value)
                        }
                      >
                        {value ? "Present" : "Absent"}
                      </Button>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  disabled={
                    !expectedProjectName.trim() &&
                    !expectedProjectPhase &&
                    !expectedProjectFactAnchorState &&
                    !expectedProjectChildContinuity &&
                    expectedUnsupportedFirstPersonClaim === undefined
                  }
                  onClick={saveCorrectedProjectTrajectory}
                >
                  Save trajectory
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <EvaluationMemoryAndArtifacts
          projection={projectionV2}
          memorySnapshot={memorySnapshot}
          preparationArtifactUses={preparationArtifactUses}
          preparationArtifactEvaluations={preparationArtifactEvaluations}
          onUpdatePreparationArtifactEvaluation={onUpdatePreparationArtifactEvaluation}
          missingMemoryId={missingMemoryId}
          onMissingMemoryIdChange={setMissingMemoryId}
          onRecord={recordGroundTruth}
        />
          </div>
        </details>
      </div>
    </details>
    </div>
  );
};


const EvaluationMemoryAndArtifacts = ({
  projection,
  memorySnapshot,
  preparationArtifactUses,
  preparationArtifactEvaluations,
  onUpdatePreparationArtifactEvaluation,
  missingMemoryId,
  onMissingMemoryIdChange,
  onRecord,
}: {
  projection: HumanEvaluationProjectionV2 | undefined;
  memorySnapshot: MemoryRetrievalEvaluationSnapshotResolution;
  preparationArtifactUses: PreparationArtifactUseReceipt[];
  preparationArtifactEvaluations: PreparationArtifactEvaluation[];
  onUpdatePreparationArtifactEvaluation: (receiptId: string, label: PreparationArtifactEvaluationLabel) => void;
  missingMemoryId: string;
  onMissingMemoryIdChange: (value: string) => void;
  onRecord: (fact: HumanGroundTruthFactV2) => void;
}) => {
  const memoryFact = projection?.activeFacts["memory-label"]?.fact;
  const artifactFact = projection?.activeFacts["artifact-quality"]?.fact;
  const entries = memorySnapshot.snapshot?.entries ?? [];
  return (
    <>
      <details className="border-t border-border/50 pt-2">
        <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">Memory</summary>
        <div className="mt-2 space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="min-w-0 border-b border-border/40 pb-2">
              <div className="break-words text-[10px]">{entry.title}</div>
              <div className="break-words font-mono text-[9px] text-muted-foreground">{entry.id}</div>
              <CriticalMomentButtonGroup
                label={`Memory relevance: ${entry.title}`}
                options={memoryEntryLabelOptions.map((option) => [option.id, option.label])}
                value={memoryFact?.kind === "memory-label" && memoryFact.memoryIds.includes(entry.id)
                  ? memoryFact.verdict : undefined}
                onSelect={(value) => {
                  const verdict = memoryEntryLabelOptions.find((option) => option.id === value)?.id;
                  if (verdict) onRecord({ kind: "memory-label", verdict, memoryIds: [entry.id] });
                }}
              />
            </div>
          ))}
          {!entries.length ? (
            <div className="text-[10px] text-muted-foreground">
              {memorySnapshot.status === "empty"
                ? "No memory entries were injected for this trace."
                : "Memory evidence is unavailable for this trace."}
            </div>
          ) : null}
          <label className="block text-[10px]">
            Missing expected memory ID
            <Input value={missingMemoryId} onChange={(event) => onMissingMemoryIdChange(event.target.value)} className="mt-1 h-7 text-[10px]" />
          </label>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={!missingMemoryId.trim()} onClick={() => {
            const id = missingMemoryId.trim();
            if (!id) return;
            onRecord({ kind: "memory-label", verdict: "missing", memoryIds: [id] });
            onMissingMemoryIdChange("");
          }}>Record missing memory</Button>
          {memoryFact?.kind === "memory-label" ? (
            <div className="break-words text-[10px]">{memoryFact.verdict}: {memoryFact.memoryIds.join(", ")}</div>
          ) : null}
        </div>
      </details>
      <details className="border-t border-border/50 pt-2">
        <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">Artifact quality</summary>
        <div className="mt-2 space-y-2">
          {(["code", "complexity", "whiteboard"] as const).map((artifact) => (
            <CriticalMomentButtonGroup
              key={artifact}
              label={`Artifact quality: ${artifact}`}
              options={[["useful", "Useful"], ["partial", "Partial"], ["wrong", "Wrong"], ["missing", "Missing"]]}
              value={artifactFact?.kind === "artifact-quality" && artifactFact.artifact === artifact ? artifactFact.verdict : undefined}
              onSelect={(value) => {
                const verdict = (["useful", "partial", "wrong", "missing"] as const).find((candidate) => candidate === value);
                if (verdict) onRecord({ kind: "artifact-quality", artifact, verdict });
              }}
            />
          ))}
          {preparationArtifactUses.map((receipt) => (
            <div key={receipt.receiptId} className="break-words text-[10px]">
              <div>{receipt.artifactPath}</div>
              <div className="font-mono text-[9px] text-muted-foreground">
                {receipt.artifactId} / {receipt.consumer} / snapshot v{receipt.snapshotVersion}
                {receipt.answerRevision == null ? "" : ` / answer r${receipt.answerRevision}`}
              </div>
              <div>{preparationArtifactEvaluations.find((evaluation) => evaluation.receiptId === receipt.receiptId)?.label ?? "Unrated"}</div>
              <div className="flex flex-wrap gap-1">
                {(["helpful", "irrelevant", "polluting", "over-constraining"] as const).map(label => (
                  <Button key={label} size="sm" variant={preparationArtifactEvaluations.find(e => e.receiptId === receipt.receiptId)?.label === label ? "default" : "outline"}
                    className="h-6 px-2 text-[10px]" onClick={() => onUpdatePreparationArtifactEvaluation(receipt.receiptId, label)}>{label}</Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </>
  );
};

function formatDetectedQuestionType(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getTraceEffectivePlaybookPhase(
  metadata: Record<string, unknown> | undefined
) {
  return (
    readStringMetadata(metadata, "effectiveAdvisorPlaybookPhase") ??
    readStringMetadata(metadata, "activeMeetingChildPhase") ??
    readStringMetadata(metadata, "activeMeetingParentPhase") ??
    readStringMetadata(metadata, "playbookPhaseDecisionPhase") ??
    readStringMetadata(metadata, "playbookPhase")
  );
}


function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatObservedBoolean(value: boolean | undefined) {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}


const TraceClassifierMetadata = ({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) => {
  const questionTypeObservation = projectQuestionTypeObservation({ metadata });
  const rows = (
    [
    ["Detected type", metadata.questionType],
    [
      "Current question",
      questionTypeObservation.observedCurrentQuestionType,
    ],
    [
      "Type authority",
      questionTypeObservation.observedCurrentQuestionTypeAuthority,
    ],
    ["Durable parent", questionTypeObservation.observedParentType],
    ["Durable parent id", questionTypeObservation.observedParentId],
    [
      "Applied to response",
      questionTypeObservation.typeAppliedToResponse,
    ],
    [
      "Applied to settlement",
      questionTypeObservation.typeAppliedToSettlement,
    ],
    ["Applied to parent", questionTypeObservation.typeAppliedToParent],
    [
      "Durable owner gap",
      questionTypeObservation.durableOwnerMissing
        ? questionTypeObservation.durableOwnerMissingReason ?? "missing"
        : "none",
    ],
    ["Frame", metadata.askFrame],
    ["Domain", metadata.topicDomain],
    ["Project", metadata.projectAnchor],
    ["Confidence", metadata.classifierConfidence],
    ["Playbook", metadata.playbookId],
    ["Phase", getTraceEffectivePlaybookPhase(metadata)],
    ["Subtype", metadata.playbookSubtype],
    ["Policy", metadata.playbookAllowedFamilies],
    ["Lexical type", metadata.taxonomyKeywordType],
    ["Semantic type", metadata.taxonomySemanticCandidateType],
    ["Hybrid shadow", metadata.taxonomyHybridOutcome],
    ["Would rescue", metadata.taxonomyHybridWouldRescue],
    ["Semantic status", metadata.taxonomySemanticEmbeddingStatus],
    ["Semantic ms", metadata.taxonomySemanticDurationMs],
    ["Semantic cache", metadata.taxonomySemanticCacheHit],
    ] satisfies Array<[string, unknown]>
  ).filter(
    (row): row is [string, Exclude<unknown, undefined | null | "">] =>
      row[1] !== undefined && row[1] !== null && row[1] !== ""
  );

  if (!rows.length) return null;

  return (
    <div className="mb-2 grid min-w-0 grid-cols-2 gap-1 rounded-sm bg-muted/40 p-2 text-[10px] sm:grid-cols-5">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <div className="text-muted-foreground">{label}</div>
          <div className="truncate font-mono" title={String(value)}>
            {String(value)}
          </div>
        </div>
      ))}
    </div>
  );
};



const AnswerDeliveryBadge = ({
  state,
}: {
  state: AnswerDeliveryPresentation["state"];
}) => {
  if (state !== "update-ready") return null;

  return (
    <Badge
      variant="outline"
      className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
    >
      Update ready
    </Badge>
  );
};

const SuggestionBlock = ({
  label,
  value,
}: {
  label: string;
  value: string;
}) => {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <MeetingMarkdownText className={WRAP_TEXT_CLASS} value={value} />
    </div>
  );
};

const CodingArtifactSection = ({
  code,
  complexity,
  isCached,
  showEmptyState = false,
}: {
  code: string;
  complexity: string;
  isCached: boolean;
  showEmptyState?: boolean;
}) => {
  if (!showEmptyState && !code && !complexity) return null;

  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <MessageSquareTextIcon className="h-3.5 w-3.5" />
        Code & complexity
        {isCached ? (
          <Badge
            variant="outline"
            className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
          >
            cached
          </Badge>
        ) : null}
      </div>
      {code ? (
        <pre
          className={cn(
            WRAP_TEXT_CLASS,
            "max-h-56 overflow-y-auto overflow-x-hidden rounded-sm bg-muted p-2 text-[11px] leading-4"
          )}
        >
          {stripOuterCodeFence(code)}
        </pre>
      ) : showEmptyState ? (
        <p
          className={cn(
            WRAP_TEXT_CLASS,
            "text-xs leading-5 text-muted-foreground"
          )}
        >
          No code needed.
        </p>
      ) : null}
      {complexity || showEmptyState ? (
        <MeetingMarkdownText
          className={cn(WRAP_TEXT_CLASS, "mt-2 text-xs leading-5")}
          value={complexity || "No complexity note."}
        />
      ) : null}
    </section>
  );
};

function formatCaptureTargetName(target: ScreenCaptureTarget) {
  const prefix =
    target.targetType === "active-window" ? "Active window" : "Monitor";
  const appName = target.appName?.trim();
  const title = target.title?.trim();

  if (appName && title) return `${prefix}: ${appName} - ${title}`;
  if (title) return `${prefix}: ${title}`;
  if (appName) return `${prefix}: ${appName}`;
  return prefix;
}

function formatCaptureTargetBounds(target: ScreenCaptureTarget) {
  return `${target.width}x${target.height} at ${target.x},${target.y}`;
}

function formatCaptureTargetMethod(target: ScreenCaptureTarget) {
  const parts = [
    target.captureMethod,
    target.windowId !== undefined ? `window ${target.windowId}` : undefined,
    target.zOrderIndex !== undefined ? `z #${target.zOrderIndex}` : undefined,
    target.selectionReason ? `selected: ${target.selectionReason}` : undefined,
    target.monitorName,
    target.imageWidth && target.imageHeight
      ? `image ${target.imageWidth}x${target.imageHeight}`
      : undefined,
    target.optimizedForScreenContext ? "optimized" : undefined,
  ].filter(Boolean);

  return parts.join(" / ");
}

function formatCaptureCursorFocus(target: ScreenCaptureTarget) {
  const cursor = target.cursor;
  if (!cursor) return "No cursor focus hint";

  const normalized =
    cursor.normalizedX !== undefined && cursor.normalizedY !== undefined
      ? ` / ${Math.round(cursor.normalizedX * 100)}%,${Math.round(
          cursor.normalizedY * 100
        )}%`
      : "";
  const position = `cursor ${cursor.targetX},${cursor.targetY}${normalized}`;
  const source = cursor.source ? ` / ${cursor.source}` : "";

  const focus = target.focusRegion
    ? ` / band ${target.focusRegion.imageWidth}x${target.focusRegion.imageHeight}`
    : "";

  return `${position} / ${
    cursor.insideTarget ? "inside target" : "outside target"
  }${focus}${source}`;
}

function formatCaptureCandidate(
  candidate: NonNullable<ScreenCaptureTarget["candidates"]>[number]
) {
  const name = [candidate.appName, candidate.title].filter(Boolean).join(" - ");
  const marker = candidate.selected ? "* " : "";
  const zOrder =
    candidate.zOrderIndex !== undefined ? `#${candidate.zOrderIndex} ` : "";
  const cursor = candidate.containsCursor ? "cursor" : "";
  const reason = candidate.skippedReason
    ? candidate.skippedReason
    : candidate.selectionReason;
  const details = [reason, cursor].filter(Boolean).join(", ");

  return `${marker}${zOrder}${name || "Untitled"} ${candidate.width}x${
    candidate.height
  }${details ? ` (${details})` : ""}`;
}

function formatTaskTimeout(minutes: number) {
  if (minutes >= 60) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function manualShortcutInvocation(
  invocation: GlobalShortcutInvocation
) {
  return {
    actionId: invocation.invocationId,
    ingressSource: "shortcut" as const,
    ingressReceivedAt: invocation.receivedAt,
    preflightRejectionReason:
      invocation.disposition === "debounced"
        ? ("shortcut-debounced" as const)
        : isJarvisEditableElementFocused()
          ? ("editable-focus" as const)
          : undefined,
  };
}

function runDispatchedShortcut(
  invocation: GlobalShortcutInvocation,
  callback: () => void
) {
  if (invocation.disposition === "dispatch") callback();
}

function isJarvisEditableElementFocused() {
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLElement && activeElement.isContentEditable)
  );
}

function getEditableInterviewSessionBrief(
  brief: InterviewSessionBrief | undefined
): InterviewSessionBrief {
  return {
    ...EMPTY_INTERVIEW_SESSION_BRIEF,
    ...brief,
    interviewTypes: brief?.interviewTypes ?? [],
    companyLocked:
      Boolean(brief?.targetCompany.trim()) && (brief?.companyLocked ?? false),
  };
}

function isEditableInterviewSessionBriefEmpty(brief: InterviewSessionBrief) {
  return (
    !brief.targetCompany.trim() &&
    brief.interviewTypes.length === 0
  );
}

function formatInterviewBriefSummary(brief: InterviewSessionBrief) {
  if (isEditableInterviewSessionBriefEmpty(brief)) {
    return "No manual interview defaults";
  }

  const parts = [
    brief.targetCompany.trim() || undefined,
    brief.companyLocked && brief.targetCompany.trim() ? "locked" : undefined,
    brief.interviewTypes.length
      ? brief.interviewTypes.map(formatInterviewBriefType).join(", ")
      : undefined,
  ].filter(Boolean);

  return parts.join(" / ");
}

function formatInterviewBriefType(type: InterviewBriefType) {
  return (
    interviewBriefTypeOptions.find((option) => option.id === type)?.label ??
    type
  );
}

function formatQuestionTypeLabel(type: CanonicalQuestionType) {
  if (type === "general-system-design") return "General system design";
  if (type === "ai-ml-system-design") return "AI/ML system design";
  if (type === "project-deep-dive") return "Project deep-dive";
  if (type === "field-knowledge") return "Field knowledge";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatSilenceDuration(config: MeetingAudioConfig) {
  const seconds = config.silence_duration_ms / 1_000;
  return `${seconds.toFixed(1)}s`;
}

function formatTraceTitle(trace: MeetingTrace) {
  const status = trace.status === "running" ? "running" : trace.status;
  return `${trace.kind} / ${status} / ${formatTraceDuration(trace.durationMs)}`;
}

function formatTraceDuration(durationMs: number | undefined) {
  if (durationMs === undefined) return "...";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatTraceExportName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function formatTraceStatusCounts(summary: MeetingTraceKindSummary) {
  const parts = [
    `${summary.success} ok`,
    summary.cancelled ? `${summary.cancelled} cancel` : undefined,
    summary.error ? `${summary.error} err` : undefined,
    summary.running ? `${summary.running} run` : undefined,
  ].filter(Boolean);

  return parts.join(" / ");
}

function formatTraceValueRange(
  summary: MeetingTraceValueSummary | undefined,
  formatter: (value: number | undefined) => string = formatTraceDuration
) {
  if (!summary?.count) return "-";
  return `${formatter(summary.p50)} / ${formatter(summary.p90)}`;
}

function formatPayloadSize(value: number | undefined) {
  if (value === undefined) return "...";
  if (value < 1024) return `${Math.round(value)}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function formatChars(value: number | undefined) {
  if (value === undefined) return "...";
  if (value < 1000) return `${Math.round(value)}`;
  return `${(value / 1000).toFixed(1)}k`;
}

function formatScreenPromptSource(source: string) {
  return source === "screenshot-auto-prompt"
    ? "Screenshot auto prompt"
    : "Meeting default";
}

function isTaskSwitchQuestion(question: string) {
  return /\bnew task|new question|next question|treat this as a new task\b/i.test(
    question
  );
}

function formatLatestReliableAnswerPreview(
  suggestion: AdvisorSuggestion | null | undefined,
  currentContent: string
) {
  if (!suggestion?.content.trim()) return "";
  const cachedContent = suggestion.content.trim();
  if (cachedContent === currentContent.trim()) return "";

  const sections = buildMeetingAnswerDisplayModel({
    content: cachedContent,
    parsedAnswer: suggestion.meetingAnswer,
    expectedProfile: suggestion.answerProfile,
  });
  const preview =
    sections.primaryAnswer ||
    sections.chineseThinking ||
    cachedContent;

  return truncateInlineText(preview, 520);
}

function truncateInlineText(value: string, maxChars: number) {
  const normalized = value
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}


function formatInterviewTargetCompany(company: InterviewTargetCompany) {
  return [
    `source ${company.source}`,
    `confidence ${Math.round(company.confidence * 100)}%`,
    company.evidence ? `evidence: ${company.evidence}` : undefined,
  ]
    .filter(Boolean)
    .join(" / ");
}

function formatParsedMeetingAnswer(answer: ParsedMeetingAnswer) {
  return JSON.stringify(
    {
      contractVersion: answer.contractVersion,
      profile: answer.profile,
      parseStatus: answer.parseStatus,
      primaryAnswerSource: answer.primaryAnswerSource,
      recognizedLabels: answer.recognizedLabels,
      missingExpectedSections: answer.missingExpectedSections,
      answerDisposition: answer.answerDisposition ?? "",
      supportingAnchorIds: answer.supportingAnchorIds,
      chineseThinking: answer.sections.chineseThinking ?? "",
      question: answer.sections.question ?? "",
      answer: answer.sections.answer ?? "",
      approach: answer.sections.approach ?? "",
      whiteboardChars: answer.sections.whiteboard?.length ?? 0,
      codeChars: answer.sections.code?.length ?? 0,
      complexity: answer.sections.complexity ?? "",
      clarifyingQuestion: answer.sections.clarifyingQuestion ?? "",
      clarifyingOptions: answer.sections.clarifyingOptions,
      rawChars: answer.rawContent.length,
      parsedAt: new Date(answer.parsedAt).toISOString(),
    },
    null,
    2
  );
}
