import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Switch,
} from "@/components";
import { useMeetingAssistant, useShortcuts, useWindowResize } from "@/hooks";
import type {
  ClarifyingQuestionAnswer,
  MeetingTrace,
  ScreenCaptureTarget,
} from "@/lib/meeting";
import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
import {
  ActivityIcon,
  BrainIcon,
  CameraIcon,
  CheckIcon,
  ClockIcon,
  EyeOffIcon,
  HelpCircleIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  Minimize2Icon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const HOTKEY_CAPTURE_SETTLE_MS = 180;
const HOTKEY_CAPTURE_DEBOUNCE_MS = 1_000;
const MEETING_PANEL_WIDTH = 920;
const PANEL_WIDTH_CLASS = "w-[920px] max-w-[100vw]";
const WRAP_TEXT_CLASS =
  "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
const TASK_TIMEOUT_OPTIONS = [15, 30, 60, 120] as const;

function waitForHotkeyCaptureSettle() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, HOTKEY_CAPTURE_SETTLE_MS);
  });
}

export const MeetingAssistant = () => {
  const meeting = useMeetingAssistant();
  const { resizeWindow } = useWindowResize();
  const [open, setOpen] = useState(false);
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
  const latestCaptureTarget = latestScreenObservation?.captureTarget;
  const displaySuggestion =
    meeting.partialSuggestion || meeting.latestSuggestion?.content || "";
  const suggestionSections = useMemo(
    () => parseSuggestionSections(displaySuggestion),
    [displaySuggestion]
  );
  const clarifyingQuestion = suggestionSections.question.trim();
  const isScreenTaskSuggestion = suggestionSections.isScreenTask;
  const clarifyingQuestionKey = clarifyingQuestion
    ? `${meeting.latestSuggestion?.id ?? displaySuggestion}:${clarifyingQuestion}`
    : "";
  const showClarifyingQuestion = Boolean(
    clarifyingQuestion && dismissedQuestionKey !== clarifyingQuestionKey
  );
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
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold">Privacy</div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      Screen
                    </span>
                    <Switch
                      checked={screenContextAllowed}
                      onCheckedChange={meeting.setScreenContextEnabled}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {privacyOptions.map((option) => (
                    <Button
                      key={option.id}
                      size="sm"
                      variant={
                        meeting.settings.privacyMode === option.id
                          ? "default"
                          : "outline"
                      }
                      className="h-7 px-1 text-[10px]"
                      onClick={() => {
                        meeting.setPrivacyMode(option.id);
                      }}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
                <div className="mt-2 border-t border-border/50 pt-2">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                    <ClockIcon className="h-3 w-3" />
                    Task memory
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {TASK_TIMEOUT_OPTIONS.map((minutes) => (
                      <Button
                        key={minutes}
                        size="sm"
                        variant={
                          meeting.settings.activeScreenTaskTimeoutMinutes ===
                          minutes
                            ? "default"
                            : "outline"
                        }
                        className="h-7 px-1 text-[10px]"
                        onClick={() => {
                          meeting.setActiveScreenTaskTimeoutMinutes(minutes);
                        }}
                      >
                        {formatTaskTimeout(minutes)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                    <ActivityIcon className="h-3 w-3" />
                    Debug Mode
                  </div>
                  <Switch
                    checked={meeting.settings.debugMode}
                    onCheckedChange={meeting.setDebugMode}
                  />
                </div>
              </section>

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
                    <p
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-14 text-sm font-medium leading-6"
                      )}
                    >
                      {suggestionSections.answer || "Waiting for screen answer."}
                    </p>
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
                        {suggestionSections.code}
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
                    <p className={cn(WRAP_TEXT_CLASS, "mt-2 text-xs leading-5")}>
                      {suggestionSections.complexity || "No complexity note."}
                    </p>
                  </section>
                </>
              ) : (
                <>
                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <BrainIcon className="h-3.5 w-3.5" />
                      Meaning
                    </div>
                    <p
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-14 text-xs leading-5"
                      )}
                    >
                      {suggestionSections.meaning || "Waiting for context."}
                    </p>
                  </section>

                  <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <MessageSquareTextIcon className="h-3.5 w-3.5" />
                      Suggested reply
                    </div>
                    <p
                      className={cn(
                        WRAP_TEXT_CLASS,
                        "min-h-20 text-xs leading-5"
                      )}
                    >
                      {suggestionSections.reply || "Waiting for suggestion."}
                    </p>
                  </section>
                </>
              )}

              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Clarifying question
                </div>
                <p
                  className={cn(
                    WRAP_TEXT_CLASS,
                    "min-h-14 text-xs leading-5"
                  )}
                >
                  {showClarifyingQuestion
                    ? clarifyingQuestion
                    : clarifyingQuestion
                      ? "Dismissed for this suggestion."
                      : "Not needed yet."}
                </p>
                {showClarifyingQuestion ? (
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-[10px]"
                      onClick={() => handleClarifyingAnswer("yes")}
                      disabled={isBusy}
                    >
                      <CheckIcon className="h-3 w-3" />
                      Yes
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-[10px]"
                      onClick={() => handleClarifyingAnswer("no")}
                      disabled={isBusy}
                    >
                      <XIcon className="h-3 w-3" />
                      No
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

              {meeting.settings.debugMode && latestTrace ? (
                <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                      <ActivityIcon className="h-3.5 w-3.5" />
                      <span className="truncate">
                        Trace: {formatTraceTitle(latestTrace)}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2 text-[10px]"
                      onClick={meeting.clearTraces}
                    >
                      Clear
                    </Button>
                  </div>
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
                title="Regenerate suggestion"
                onClick={meeting.regenerateSuggestion}
                disabled={isBusy || !hasMeetingContext}
              >
                <RefreshCwIcon className="h-3.5 w-3.5" />
                Regenerate
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                title="Make suggestion shorter"
                onClick={meeting.makeSuggestionShorter}
                disabled={isBusy || !hasSuggestion}
              >
                <Minimize2Icon className="h-3.5 w-3.5" />
                Shorter
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

const Metric = ({ label, value }: { label: string; value: number | string }) => {
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
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
      <p className={cn(WRAP_TEXT_CLASS, "text-xs leading-5")}>{value}</p>
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

function formatTraceTitle(trace: MeetingTrace) {
  const status = trace.status === "running" ? "running" : trace.status;
  return `${trace.kind} / ${status} / ${formatTraceDuration(trace.durationMs)}`;
}

function formatTraceDuration(durationMs: number | undefined) {
  if (durationMs === undefined) return "...";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatScreenPromptSource(source: string) {
  return source === "screenshot-auto-prompt"
    ? "Screenshot auto prompt"
    : "Meeting default";
}

const sectionBoundaryLabels = [
  "Meaning",
  "Reply",
  "Suggested reply",
  "Question",
  "Answer",
  "Approach",
  "Code",
  "Complexity",
  "Clarifying question",
];

function parseSuggestionSections(content: string) {
  const trimmedContent = sanitizeSectionText(content);

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
      isScreenTask: false,
    };
  }

  const screenQuestion = readSuggestionSection(trimmedContent, ["Question"]);
  const answer = readSuggestionSection(trimmedContent, ["Answer"]);
  const approach = readSuggestionSection(trimmedContent, ["Approach"]);
  const code = readSuggestionSection(trimmedContent, ["Code"]);
  const complexity = readSuggestionSection(trimmedContent, ["Complexity"]);
  const clarifyingQuestion = readSuggestionSection(trimmedContent, [
    "Clarifying question",
  ]);
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
    isScreenTask,
  };
}

function readSuggestionSection(content: string, labels: string[]) {
  const labelPattern = labels.map(escapeRegExp).join("|");
  const boundaryPattern = sectionBoundaryLabels.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${labelPattern})\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:${boundaryPattern})\\s*:|$)`,
    "i"
  );
  const match = pattern.exec(content);

  return sanitizeSectionText(match?.[1] ?? "");
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
