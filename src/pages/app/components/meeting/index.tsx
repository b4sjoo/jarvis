import {
  Badge,
  Button,
  Input,
  Label,
  Markdown,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Slider,
  Switch,
  Textarea,
} from "@/components";
import { useMeetingAssistant, useShortcuts, useWindowResize } from "@/hooks";
import type {
  ClarifyingQuestionAnswer,
  InterviewBriefType,
  InterviewSessionBrief,
  InterviewTargetCompany,
  MeetingAudioConfig,
  MeetingAudioProfile,
  MeetingResponseActionMode,
  MeetingResponseConfig,
  MeetingResponseLanguage,
  MeetingResponseLength,
  MeetingTrace,
  MeetingTraceKindSummary,
  MeetingTraceSummary,
  MeetingTraceValueSummary,
  ScreenCaptureTarget,
  ScreenTaskAnswer,
} from "@/lib/meeting";
import {
  hasScreenTaskAnswerContent,
  parseScreenTaskAnswer,
  stripOuterCodeFence,
  summarizeMeetingTraces,
} from "@/lib/meeting";
import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
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
  MessageSquareTextIcon,
  MousePointer2Icon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
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

const statusLabel = {
  idle: "Ready",
  starting: "Starting",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  paused: "Paused",
  error: "Needs attention",
};

const privacyOptions = [
  { id: "memory-only", label: "Memory" },
  { id: "text-to-cloud", label: "Text" },
  { id: "text-and-screen-to-cloud", label: "Text+Screen" },
] as const;

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
    id: "speakable",
    label: "Speakable",
    title: "Rewrite the current answer as something you can say aloud",
  },
  {
    id: "bilingual",
    label: "Bilingual",
    title: "Show concise English and Chinese wording for the current answer",
  },
  {
    id: "focus",
    label: "Focus",
    title: "Refocus the current answer on the most useful technical point",
  },
];

const HOTKEY_CAPTURE_SETTLE_MS = 180;
const HOTKEY_CAPTURE_DEBOUNCE_MS = 1_000;
const MEETING_PANEL_WIDTH = 920;
const PANEL_WIDTH_CLASS = "w-[920px] max-w-[100vw]";
const WRAP_TEXT_CLASS =
  "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
const TASK_TIMEOUT_OPTIONS = [15, 30, 60, 120] as const;

const EMPTY_INTERVIEW_SESSION_BRIEF: InterviewSessionBrief = {
  targetCompany: "",
  targetCompanyNormalized: undefined,
  companyLocked: true,
  interviewTypes: [],
  focusAreas: "",
  notes: "",
};

const interviewBriefTypeOptions: Array<{
  id: InterviewBriefType;
  label: string;
}> = [
  { id: "behavioral", label: "Behavioral" },
  { id: "coding", label: "Coding" },
  { id: "system-design", label: "System design" },
  { id: "project-deep-dive", label: "Project deep-dive" },
  { id: "mixed", label: "Mixed" },
];

function waitForHotkeyCaptureSettle() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, HOTKEY_CAPTURE_SETTLE_MS);
  });
}

export const MeetingAssistant = () => {
  const meeting = useMeetingAssistant();
  const { resizeWindow } = useWindowResize();
  const [open, setOpen] = useState(false);
  const [configurationsOpen, setConfigurationsOpen] = useState(false);
  const [interviewBriefOpen, setInterviewBriefOpen] = useState(false);
  const [dismissedQuestionKey, setDismissedQuestionKey] = useState<
    string | null
  >(null);
  const screenHotkeyInFlightRef = useRef(false);
  const lastScreenHotkeyAtRef = useRef(0);

  const latestTurn =
    meeting.transcriptTurns[meeting.transcriptTurns.length - 1];
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
  const completedScreenTaskAnswer =
    meeting.partialSuggestion || !meeting.latestSuggestion?.screenTaskAnswer
      ? undefined
      : meeting.latestSuggestion.screenTaskAnswer;
  const suggestionSections = useMemo(
    () => parseSuggestionSections(displaySuggestion, completedScreenTaskAnswer),
    [completedScreenTaskAnswer, displaySuggestion]
  );
  const clarifyingQuestion = suggestionSections.question.trim();
  const isScreenTaskSuggestion = suggestionSections.isScreenTask;
  const clarifyingQuestionKey = clarifyingQuestion
    ? `${meeting.latestSuggestion?.id ?? displaySuggestion}:${clarifyingQuestion}`
    : "";
  const showClarifyingQuestion = Boolean(
    clarifyingQuestion && dismissedQuestionKey !== clarifyingQuestionKey
  );
  const isTaskSwitchClarifyingQuestion =
    isTaskSwitchQuestion(clarifyingQuestion);
  const isBusy =
    meeting.status === "starting" ||
    meeting.status === "transcribing" ||
    meeting.status === "thinking";
  const isListening = meeting.status === "listening";
  const isPaused = meeting.status === "paused";
  const isRunning =
    meeting.status === "listening" ||
    meeting.status === "transcribing" ||
    meeting.status === "thinking";
  const screenContextAllowed =
    meeting.settings.screenContextEnabled &&
    meeting.settings.privacyMode === "text-and-screen-to-cloud";
  const hasMeetingContext =
    meeting.transcriptTurns.length > 0 || meeting.screenObservations.length > 0;
  const hasSuggestion = Boolean(displaySuggestion.trim());

  const title = useMemo(() => {
    if (meeting.error) {
      return `Meeting assistant needs attention: ${meeting.error}`;
    }

    return "Open meeting assistant";
  }, [meeting.error]);

  const captureScreenContextFromHotkey = useCallback(async () => {
    const requestedAt = Date.now();

    if (
      screenHotkeyInFlightRef.current ||
      requestedAt - lastScreenHotkeyAtRef.current < HOTKEY_CAPTURE_DEBOUNCE_MS
    ) {
      return;
    }

    screenHotkeyInFlightRef.current = true;
    lastScreenHotkeyAtRef.current = requestedAt;

    try {
      if (open) {
        setOpen(false);
        await waitForHotkeyCaptureSettle();
        await resizeWindow(false);
        await waitForHotkeyCaptureSettle();
      }

      await meeting.captureScreenContext("hotkey", {
        requestedAt,
        onCaptured: () => {
          setOpen(true);
        },
      });
      setOpen(true);
    } finally {
      screenHotkeyInFlightRef.current = false;
    }
  }, [meeting.captureScreenContext, open, resizeWindow]);

  const meetingShortcutCallbacks = useMemo(
    () => ({
      meeting_screen_context: () => {
        void captureScreenContextFromHotkey();
      },
    }),
    [captureScreenContextFromHotkey]
  );

  useShortcuts({
    customShortcuts: meetingShortcutCallbacks,
  });

  useEffect(() => {
    void resizeWindow(open, open ? { width: MEETING_PANEL_WIDTH } : undefined);
  }, [open, resizeWindow]);

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
    if (isPaused) {
      await meeting.resume();
    } else if (isRunning || meeting.status === "starting") {
      await meeting.stop();
    } else {
      await meeting.start();
    }
  };

  const handlePauseResume = async () => {
    if (isPaused) {
      await meeting.resume();
      return;
    }

    if (isRunning) {
      await meeting.pause();
    }
  };

  const handleClarifyingAnswer = useCallback(
    (answer: ClarifyingQuestionAnswer) => {
      if (!clarifyingQuestion) return;

      setDismissedQuestionKey(null);
      void meeting.answerClarifyingQuestion(clarifyingQuestion, answer);
    },
    [clarifyingQuestion, meeting.answerClarifyingQuestion]
  );

  const handleNewTaskConfirmation = useCallback(() => {
    if (!clarifyingQuestionKey) return;

    meeting.clearActiveScreenTask();
    setDismissedQuestionKey(clarifyingQuestionKey);
  }, [clarifyingQuestionKey, meeting.clearActiveScreenTask]);

  const handleSameTaskConfirmation = useCallback(() => {
    if (!clarifyingQuestionKey) return;

    setDismissedQuestionKey(clarifyingQuestionKey);
  }, [clarifyingQuestionKey]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant={isRunning ? "default" : "outline"}
          title={title}
          className={cn(
            "cursor-pointer",
            meeting.error && "border-red-300 bg-red-50 hover:bg-red-100"
          )}
        >
          {isBusy ? (
            <Loader2Icon className="h-4 w-4 animate-spin" />
          ) : isListening ? (
            <RadioIcon className="h-4 w-4" />
          ) : isPaused ? (
            <PlayIcon className="h-4 w-4" />
          ) : (
            <BrainIcon className="h-4 w-4" />
          )}
        </Button>
      </PopoverTrigger>

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
          <div className="flex items-center justify-between gap-2 border-b border-border/50 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <BrainIcon className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  Meeting Assistant
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {statusLabel[meeting.status]}
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
                {statusLabel[meeting.status]}
              </Badge>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                title="Capture current screen context"
                onClick={() => {
                  void meeting.captureScreenContext();
                }}
                disabled={meeting.status === "starting" || !screenContextAllowed}
              >
                <CameraIcon className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                title={isPaused ? "Resume" : "Pause"}
                onClick={handlePauseResume}
                disabled={!isRunning && !isPaused}
              >
                {isPaused ? (
                  <PlayIcon className="h-4 w-4" />
                ) : (
                  <PauseIcon className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="icon"
                variant={
                  isRunning || isBusy || isPaused ? "destructive" : "default"
                }
                className="h-8 w-8"
                title={isRunning || isBusy || isPaused ? "Stop" : "Start"}
                onClick={handleToggle}
              >
                {isRunning || isBusy || isPaused ? (
                  <SquareIcon className="h-4 w-4" />
                ) : (
                  <PlayIcon className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 max-w-full space-y-3 overflow-x-hidden p-3">
              <ConfigurationsPanel
                open={configurationsOpen}
                onOpenChange={setConfigurationsOpen}
                responseConfig={meeting.settings.response}
                onResponseConfigChange={meeting.setResponseConfig}
                privacyMode={meeting.settings.privacyMode}
                onPrivacyModeChange={meeting.setPrivacyMode}
                activeScreenTaskTimeoutMinutes={
                  meeting.settings.activeScreenTaskTimeoutMinutes
                }
                onActiveScreenTaskTimeoutMinutesChange={
                  meeting.setActiveScreenTaskTimeoutMinutes
                }
                useMemory={meeting.settings.useMemory}
                onUseMemoryChange={meeting.setUseMemory}
                audioProfile={meeting.settings.audio.profile}
                audioConfig={meeting.settings.audio.config}
                onAudioProfileChange={meeting.setMeetingAudioProfile}
                onAudioConfigChange={meeting.setMeetingAudioConfig}
                debugMode={meeting.settings.debugMode}
                onDebugModeChange={meeting.setDebugMode}
              />

              <InterviewSessionBriefPanel
                open={interviewBriefOpen}
                onOpenChange={setInterviewBriefOpen}
                brief={meeting.interviewSessionBrief}
                onBriefChange={meeting.setInterviewSessionBrief}
                onClear={meeting.clearInterviewSessionBrief}
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

              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Latest transcript
                </div>
                <p
                  className={cn(
                    WRAP_TEXT_CLASS,
                    "min-h-10 text-xs leading-5 text-muted-foreground"
                  )}
                >
                  {latestTurn?.text || "Waiting for meeting audio."}
                </p>
              </section>

              {isScreenTaskSuggestion ? (
                <>
                  <section className="min-w-0 overflow-hidden rounded-md border border-primary/30 bg-primary/5 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <BrainIcon className="h-3.5 w-3.5" />
                      Answer
                    </div>
                    <MeetingMarkdownText
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-14 text-sm font-medium leading-6"
                      )}
                      value={
                        suggestionSections.answer || "Waiting for screen answer."
                      }
                    />
                  </section>

                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <MessageSquareTextIcon className="h-3.5 w-3.5" />
                      Task details
                    </div>
                    <div className="space-y-2">
                      <SuggestionBlock
                        label="Question"
                        value={
                          suggestionSections.screenQuestion ||
                          "Waiting for focused question."
                        }
                      />
                      <SuggestionBlock
                        label="Approach"
                        value={suggestionSections.approach || "Not needed yet."}
                      />
                    </div>
                  </section>

                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <MessageSquareTextIcon className="h-3.5 w-3.5" />
                      Code & complexity
                    </div>
                    {suggestionSections.code ? (
                      <pre
                        className={cn(
                          WRAP_TEXT_CLASS,
                          "max-h-56 overflow-y-auto overflow-x-hidden rounded-sm bg-muted p-2 text-[11px] leading-4"
                        )}
                      >
                        {stripOuterCodeFence(suggestionSections.code)}
                      </pre>
                    ) : (
                      <p
                        className={cn(
                          WRAP_TEXT_CLASS,
                          "text-xs leading-5 text-muted-foreground"
                        )}
                      >
                        No code needed.
                      </p>
                    )}
                    <MeetingMarkdownText
                      className={cn(WRAP_TEXT_CLASS, "mt-2 text-xs leading-5")}
                      value={suggestionSections.complexity || "No complexity note."}
                    />
                  </section>
                </>
              ) : (
                <>
                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <BrainIcon className="h-3.5 w-3.5" />
                      Meaning
                    </div>
                    <MeetingMarkdownText
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-14 text-xs leading-5"
                      )}
                      value={suggestionSections.meaning || "Waiting for context."}
                    />
                  </section>

                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <MessageSquareTextIcon className="h-3.5 w-3.5" />
                      Suggested reply
                    </div>
                    <MeetingMarkdownText
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-20 text-xs leading-5"
                      )}
                      value={suggestionSections.reply || "Waiting for suggestion."}
                    />
                  </section>
                </>
              )}

              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-2.5">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <SlidersHorizontalIcon className="h-3.5 w-3.5" />
                  Response actions
                </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    title="Regenerate with the current Meeting Assistant response settings"
                    onClick={meeting.regenerateSuggestion}
                    disabled={isBusy || !hasMeetingContext}
                  >
                    Regenerate
                  </Button>
                  {responseActionOptions.map((action) => (
                    <Button
                      key={action.id}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[10px]"
                      title={action.title}
                      onClick={() => {
                        void meeting.applyResponseAction(action.id);
                      }}
                      disabled={isBusy || !hasSuggestion}
                    >
                      {action.label}
                    </Button>
                  ))}
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
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-[10px]"
                      onClick={
                        isTaskSwitchClarifyingQuestion
                          ? handleNewTaskConfirmation
                          : () => handleClarifyingAnswer("yes")
                      }
                      disabled={isBusy}
                    >
                      <CheckIcon className="h-3 w-3" />
                      {isTaskSwitchClarifyingQuestion ? "New task" : "Yes"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-[10px]"
                      onClick={
                        isTaskSwitchClarifyingQuestion
                          ? handleSameTaskConfirmation
                          : () => handleClarifyingAnswer("no")
                      }
                      disabled={isBusy}
                    >
                      <XIcon className="h-3 w-3" />
                      {isTaskSwitchClarifyingQuestion ? "Same task" : "No"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-[10px]"
                      onClick={() => handleClarifyingAnswer("not-sure")}
                      disabled={isBusy}
                    >
                      <HelpCircleIcon className="h-3 w-3" />
                      Not sure
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-[10px]"
                      onClick={() => {
                        setDismissedQuestionKey(clarifyingQuestionKey);
                      }}
                    >
                      <EyeOffIcon className="h-3 w-3" />
                      Dismiss
                    </Button>
                  </div>
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
                  {isScreenTaskSuggestion &&
                  hasScreenTaskAnswerContent(suggestionSections.screenAnswer) ? (
                    <details className="mt-2 border-t border-border/50 pt-2">
                      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
                        Parsed screen answer
                      </summary>
                      <pre
                        className={cn(
                          WRAP_TEXT_CLASS,
                          "mt-2 max-h-40 overflow-y-auto overflow-x-hidden rounded-sm bg-muted p-2 text-[10px] leading-4"
                        )}
                      >
                        {formatParsedScreenAnswer(suggestionSections.screenAnswer)}
                      </pre>
                    </details>
                  ) : null}
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
                title="Clear active screen task"
                onClick={meeting.clearActiveScreenTask}
                disabled={!meeting.activeScreenTask}
              >
                <Trash2Icon className="h-3.5 w-3.5" />
                Clear task
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={handlePauseResume}
                disabled={!isRunning && !isPaused}
              >
                {isPaused ? (
                  <PlayIcon className="h-3.5 w-3.5" />
                ) : (
                  <PauseIcon className="h-3.5 w-3.5" />
                )}
                {isPaused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant={
                  isRunning || isBusy || isPaused ? "destructive" : "default"
                }
                className="h-8 gap-1.5 text-xs"
                onClick={handleToggle}
              >
                {isRunning || isBusy || isPaused ? (
                  <SquareIcon className="h-3.5 w-3.5" />
                ) : (
                  <PlayIcon className="h-3.5 w-3.5" />
                )}
                {isRunning || isBusy || isPaused ? "Stop" : "Start"}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const InterviewSessionBriefPanel = ({
  open,
  onOpenChange,
  brief,
  onBriefChange,
  onClear,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brief?: InterviewSessionBrief;
  onBriefChange: (brief: InterviewSessionBrief | undefined) => void;
  onClear: () => void;
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
                  updateBrief({ targetCompany: event.currentTarget.value });
                }}
              />
            </div>
            <div className="flex min-w-[170px] items-center justify-between gap-2 rounded-sm border border-border/60 p-2">
              <div>
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  Lock company
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Skip inference when set
                </div>
              </div>
              <Switch
                checked={editableBrief.companyLocked}
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
            <div className="grid grid-cols-2 gap-1 md:grid-cols-5">
              {interviewBriefTypeOptions.map((option) => {
                const selected = editableBrief.interviewTypes.includes(
                  option.id
                );

                return (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    className="h-7 px-1 text-[10px]"
                    onClick={() => {
                      updateBrief({
                        interviewTypes: selected
                          ? editableBrief.interviewTypes.filter(
                              (type) => type !== option.id
                            )
                          : [...editableBrief.interviewTypes, option.id],
                      });
                    }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
              Focus areas
            </Label>
            <Textarea
              value={editableBrief.focusAreas}
              placeholder="Leadership principles, likely topics, system design themes..."
              className="min-h-16 resize-none text-xs"
              onChange={(event) => {
                updateBrief({ focusAreas: event.currentTarget.value });
              }}
            />
          </div>

          <div>
            <Label className="mb-1.5 block text-[10px] font-medium uppercase text-muted-foreground">
              Notes
            </Label>
            <Textarea
              value={editableBrief.notes}
              placeholder="Anything known before the call: interviewer hints, role scope, expected round length..."
              className="min-h-20 resize-none text-xs"
              onChange={(event) => {
                updateBrief({ notes: event.currentTarget.value });
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[10px] text-muted-foreground">
              Used as session background context, independent from software
              configuration.
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

const ConfigurationsPanel = ({
  open,
  onOpenChange,
  responseConfig,
  onResponseConfigChange,
  privacyMode,
  onPrivacyModeChange,
  activeScreenTaskTimeoutMinutes,
  onActiveScreenTaskTimeoutMinutesChange,
  useMemory,
  onUseMemoryChange,
  audioProfile,
  audioConfig,
  onAudioProfileChange,
  onAudioConfigChange,
  debugMode,
  onDebugModeChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  responseConfig: MeetingResponseConfig;
  onResponseConfigChange: (config: MeetingResponseConfig) => void;
  privacyMode: (typeof privacyOptions)[number]["id"];
  onPrivacyModeChange: (mode: (typeof privacyOptions)[number]["id"]) => void;
  activeScreenTaskTimeoutMinutes: number;
  onActiveScreenTaskTimeoutMinutesChange: (minutes: number) => void;
  useMemory: boolean;
  onUseMemoryChange: (enabled: boolean) => void;
  audioProfile: MeetingAudioProfile;
  audioConfig: MeetingAudioConfig;
  onAudioProfileChange: (profile: MeetingAudioProfile) => void;
  onAudioConfigChange: (config: MeetingAudioConfig) => void;
  debugMode: boolean;
  onDebugModeChange: (enabled: boolean) => void;
}) => {
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
          </ConfigurationGroup>

          <ConfigurationGroup
            icon={<ClockIcon className="h-3.5 w-3.5" />}
            title="Context"
          >
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <Label className="text-[10px] font-medium uppercase text-muted-foreground">
                  Privacy
                </Label>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {privacyOptions.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={privacyMode === option.id ? "default" : "outline"}
                    className="h-7 px-1 text-[10px]"
                    onClick={() => {
                      onPrivacyModeChange(option.id);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
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
          </ConfigurationGroup>

          <ConfigurationGroup
            icon={<Volume2Icon className="h-3.5 w-3.5" />}
            title="Audio"
          >
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
              value={audioConfig.silence_chunks}
              displayValue={formatSilenceDuration(audioConfig)}
              min={20}
              max={180}
              step={5}
              onChange={(value) => {
                onAudioConfigChange({
                  ...audioConfig,
                  silence_chunks: Math.round(value),
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
          </ConfigurationGroup>
        </div>
      ) : null}
    </section>
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

const MEETING_MARKDOWN_CLASS =
  "text-xs leading-5 [&_code]:text-[10px] [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-2 [&_pre]:max-h-72 [&_pre]:overflow-auto [&_strong]:font-semibold [&_ul]:my-1";

const MeetingMarkdownText = ({
  value,
  className,
}: {
  value: string;
  className?: string;
}) => {
  return (
    <div className={cn(MEETING_MARKDOWN_CLASS, className)}>
      <Markdown>{normalizeMeetingMarkdown(value)}</Markdown>
    </div>
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
  const reason = candidate.skippedReason ? ` (${candidate.skippedReason})` : "";

  return `${name || "Untitled"} ${candidate.width}x${candidate.height}${reason}`;
}

function formatTaskTimeout(minutes: number) {
  if (minutes >= 60) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function getEditableInterviewSessionBrief(
  brief: InterviewSessionBrief | undefined
): InterviewSessionBrief {
  return {
    ...EMPTY_INTERVIEW_SESSION_BRIEF,
    ...brief,
    interviewTypes: brief?.interviewTypes ?? [],
    companyLocked: brief?.companyLocked ?? true,
    focusAreas: brief?.focusAreas ?? "",
    notes: brief?.notes ?? "",
  };
}

function isEditableInterviewSessionBriefEmpty(brief: InterviewSessionBrief) {
  return (
    !brief.targetCompany.trim() &&
    brief.interviewTypes.length === 0 &&
    !brief.focusAreas.trim() &&
    !brief.notes.trim()
  );
}

function formatInterviewBriefSummary(brief: InterviewSessionBrief) {
  if (isEditableInterviewSessionBriefEmpty(brief)) {
    return "No pre-meeting background context";
  }

  const parts = [
    brief.targetCompany.trim() || undefined,
    brief.companyLocked && brief.targetCompany.trim() ? "locked" : undefined,
    brief.interviewTypes.length
      ? brief.interviewTypes.map(formatInterviewBriefType).join(", ")
      : undefined,
    brief.focusAreas.trim() || brief.notes.trim() || undefined,
  ].filter(Boolean);

  return parts.join(" / ");
}

function formatInterviewBriefType(type: InterviewBriefType) {
  return (
    interviewBriefTypeOptions.find((option) => option.id === type)?.label ??
    type
  );
}

function formatSilenceDuration(config: MeetingAudioConfig) {
  const seconds = (config.silence_chunks * config.hop_size) / 44100;
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

const sectionBoundaryLabels = [
  "Meaning",
  "Reply",
  "Suggested reply",
  "Question",
  "Answer",
  "Approach",
  "Code",
  "Implementation",
  "Complexity",
  "Clarifying question",
];

function parseSuggestionSections(
  content: string,
  screenTaskAnswer?: ScreenTaskAnswer
) {
  const trimmedContent = sanitizeSectionText(content);
  const parsedScreenTaskAnswer =
    screenTaskAnswer?.rawContent === trimmedContent
      ? screenTaskAnswer
      : parseScreenTaskAnswer(trimmedContent);

  if (!trimmedContent) {
    return {
      meaning: "",
      reply: "",
      question: "",
      screenQuestion: "",
      answer: "",
      approach: "",
      code: "",
      complexity: "",
      screenAnswer: parsedScreenTaskAnswer,
      isScreenTask: false,
    };
  }

  const screenQuestion = parsedScreenTaskAnswer.question ?? "";
  const answer = parsedScreenTaskAnswer.answer ?? "";
  const approach = parsedScreenTaskAnswer.approach ?? "";
  const code = parsedScreenTaskAnswer.code ?? "";
  const complexity = parsedScreenTaskAnswer.complexity ?? "";
  const clarifyingQuestion = parsedScreenTaskAnswer.clarifyingQuestion ?? "";
  const isScreenTask = Boolean(answer || approach || code || complexity);
  const meaning = readSuggestionSection(trimmedContent, ["Meaning"]);
  const reply = readSuggestionSection(trimmedContent, [
    "Reply",
    "Suggested reply",
  ]);
  const question = isScreenTask
    ? clarifyingQuestion
    : readSuggestionSection(trimmedContent, [
        "Question",
        "Clarifying question",
      ]);
  const hasStructuredSections = Boolean(meaning || reply || question);

  return {
    meaning,
    reply: reply || (hasStructuredSections ? "" : trimmedContent),
    question,
    screenQuestion,
    answer,
    approach,
    code,
    complexity,
    screenAnswer: parsedScreenTaskAnswer,
    isScreenTask,
  };
}

function readSuggestionSection(content: string, labels: string[]) {
  const labelPattern = labels.map(escapeRegExp).join("|");
  const boundaryPattern = sectionBoundaryLabels.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${labelPattern})(?:\\s*\\([^\\n:)]*\\))?\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:${boundaryPattern})(?:\\s*\\([^\\n:)]*\\))?\\s*:|$)`,
    "i"
  );
  const match = pattern.exec(content);

  return sanitizeSectionText(match?.[1] ?? "");
}

function normalizeMeetingMarkdown(value: string) {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map((segment) =>
      segment.startsWith("```") ? segment : normalizeMeetingMathText(segment)
    )
    .join("");
}

function normalizeMeetingMathText(value: string) {
  return value
    .replace(/\\\$\\\$([\s\S]*?)\\\$\\\$/g, (_, expression: string) =>
      normalizeMathExpression(expression)
    )
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expression: string) =>
      normalizeMathExpression(expression)
    )
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expression: string) =>
      normalizeMathExpression(expression)
    )
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) =>
      normalizeMathExpression(expression)
    )
    .replace(/\\\$([^$\n]+?)\\\$/g, (_, expression: string) =>
      normalizeMathExpression(expression)
    )
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix: string, expression: string) =>
      `${prefix}${normalizeMathExpression(expression)}`
    );
}

function normalizeMathExpression(expression: string) {
  return expression
    .trim()
    .replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, "$1")
    .replace(/\\times/g, "x")
    .replace(/\\cdot/g, "*")
    .replace(/\\leq/g, "<=")
    .replace(/\\geq/g, ">=")
    .replace(/\\neq/g, "!=")
    .replace(/\\left|\\right/g, "")
    .replace(/\\log/g, "log")
    .replace(/[{}]/g, "")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/\s+/g, " ");
}

function sanitizeSectionText(value: string) {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s*/, "")
    .trim();

  return trimmed === "-" ? "" : trimmed;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function formatParsedScreenAnswer(answer: ScreenTaskAnswer) {
  return JSON.stringify(
    {
      question: answer.question ?? "",
      answer: answer.answer ?? "",
      approach: answer.approach ?? "",
      codeChars: answer.code?.length ?? 0,
      complexity: answer.complexity ?? "",
      clarifyingQuestion: answer.clarifyingQuestion ?? "",
      rawChars: answer.rawContent.length,
      parsedAt: new Date(answer.parsedAt).toISOString(),
    },
    null,
    2
  );
}
