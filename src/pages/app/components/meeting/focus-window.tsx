import {
  Badge,
  Button,
  Input,
  ScrollArea,
} from "@/components";
import type {
  CanonicalQuestionType,
  ClarifyingQuestionAnswer,
  InterviewBriefType,
  MeetingFocusUserAction,
  MeetingFocusSnapshotEnvelope,
  MeetingFocusSnapshot,
  MeetingFocusWindowKind,
} from "@/lib/meeting";
import {
  EMPTY_MEETING_FOCUS_SNAPSHOT,
  FOCUS_CONTROLS_CORRECTION_HISTORY_HEIGHT,
  FOCUS_CONTROLS_TRANSCRIPT_MEASURE_WIDTH,
  MEETING_FOCUS_ACTION_EVENT,
  MEETING_FOCUS_SNAPSHOT_EVENT,
  resolveFocusControlsGeometry,
  stripOuterCodeFence,
} from "@/lib/meeting";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  AlertCircleIcon,
  BrainIcon,
  CheckIcon,
  ClockIcon,
  Code2Icon,
  FileTextIcon,
  HelpCircleIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  PauseIcon,
  PlayIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { WhiteboardViewer } from "./whiteboard-viewer";
import { createMeetingFocusConsumer } from "@/lib/meeting/focus-window-protocol";
import { FactGuardrailNotice } from "./fact-guardrail-notice";
import { formatChineseThinkingText } from "@/lib/meeting/meeting-display-text";
import { MeetingMarkdownText } from "./meeting-markdown-text";

const WRAP_TEXT_CLASS =
  "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
const CHINESE_THINKING_TEXT_CLASS =
  "min-w-0 break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere] [&_*]:leading-5 [&_li]:my-0 [&_ol]:my-0 [&_p]:my-0 [&_p+p]:mt-1 [&_ul]:my-0";

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

export function MeetingFocusWindow({ kind }: { kind: MeetingFocusWindowKind }) {
  const [envelope, setEnvelope] = useState<MeetingFocusSnapshotEnvelope>();
  const [protocolError, setProtocolError] = useState<string>();
  const consumerRef = useRef<ReturnType<typeof createMeetingFocusConsumer> | null>(null);

  useEffect(() => {
    const consumer = createMeetingFocusConsumer({
      windowKind: kind,
      transport: {
        subscribe: (receive) => listen(MEETING_FOCUS_SNAPSHOT_EVENT, (message) => receive(message.payload)),
        send: (action) => emit(MEETING_FOCUS_ACTION_EVENT, action),
      },
      onSnapshot: (next) => { setEnvelope(next); setProtocolError(undefined); },
      onError: (error) => setProtocolError(error.message),
    });
    consumerRef.current = consumer;
    void consumer.start().catch(() => undefined);
    return () => {
      consumer.dispose();
      consumerRef.current = null;
    };
  }, [kind]);

  useEffect(() => {
    // Confirms this React commit, not deferred Markdown/Mermaid rendering or pixels.
    if (envelope) consumerRef.current?.applied(envelope);
  }, [envelope]);

  const snapshot = envelope?.payload ?? EMPTY_MEETING_FOCUS_SNAPSHOT;
  const sendFocusAction = (action: MeetingFocusUserAction) => { void consumerRef.current?.dispatch(action); };
  return <div className="contents" data-focus-window={kind}
    data-focus-publisher={envelope?.publisherInstanceId} data-focus-sequence={envelope?.sequence}>
    {protocolError ? <div role="alert" className="fixed inset-x-2 top-2 z-50 rounded-sm border border-destructive bg-background p-2 text-xs text-destructive">{protocolError}</div> : null}
    {kind === "controls"
      ? <MeetingFocusControlsWindow snapshot={snapshot} sendFocusAction={sendFocusAction} />
      : <MeetingFocusAnswerWindow snapshot={snapshot} sendFocusAction={sendFocusAction} />}
  </div>;
}

function MeetingFocusAnswerWindow({
  snapshot,
  sendFocusAction,
}: {
  snapshot: MeetingFocusSnapshot;
  sendFocusAction: (action: MeetingFocusUserAction) => void;
}) {
  const sections = snapshot.sections;
  const focusAnswer = sections.primaryAnswer;
  const focusThinking =
    sections.chineseThinking || "等待 Jarvis 给出中文思路。";

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 shadow-lg backdrop-blur">
        <ScrollArea className="meeting-assistant-main-scroll min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
          <div className="min-w-0 space-y-2 overflow-x-hidden p-3">
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
                {snapshot.answerDelivery.state === "update-ready" ? (
                  <Badge
                    variant="outline"
                    className="ml-auto rounded-sm px-1.5 py-0 text-[10px] font-normal"
                  >
                    Update ready
                  </Badge>
                ) : null}
              </div>
              <FactGuardrailNotice notice={snapshot.factGuardrailNotice} />
              <MeetingMarkdownText
                className={cn(WRAP_TEXT_CLASS, "min-h-20 text-sm leading-6")}
                value={focusAnswer || "Waiting for answer."}
              />
            </section>

            {sections.approach ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Approach
                </div>
                <MeetingMarkdownText
                  className={cn(WRAP_TEXT_CLASS, "text-xs leading-5")}
                  value={sections.approach}
                />
              </section>
            ) : null}

            {sections.whiteboard ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-muted/20 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <FileTextIcon className="h-3.5 w-3.5" />
                  Whiteboard
                </div>
                <WhiteboardViewer
                  value={sections.whiteboard}
                  viewKey={sections.whiteboardViewKey}
                />
              </section>
            ) : null}

            {sections.code || sections.complexity ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <Code2Icon className="h-3.5 w-3.5" />
                  Code & complexity
                </div>
                {sections.code ? (
                  <pre
                    className={cn(
                      WRAP_TEXT_CLASS,
                      "overflow-x-hidden rounded-sm bg-muted p-2 text-[11px] leading-4"
                    )}
                  >
                    {stripOuterCodeFence(sections.code)}
                  </pre>
                ) : null}
                {sections.complexity ? (
                  <MeetingMarkdownText
                    className={cn(WRAP_TEXT_CLASS, "mt-2 text-xs leading-5")}
                    value={sections.complexity}
                  />
                ) : null}
              </section>
            ) : null}

            {snapshot.showClarifyingQuestion ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <HelpCircleIcon className="h-3.5 w-3.5" />
                  Clarify
                </div>
                <MeetingMarkdownText
                  className={cn(WRAP_TEXT_CLASS, "text-xs leading-5")}
                  value={snapshot.clarifyingQuestion}
                />
                <FocusClarifyingActionButtons snapshot={snapshot} sendFocusAction={sendFocusAction} />
              </section>
            ) : null}

            {snapshot.latestReliableAnswer ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/30 p-2.5">
                <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <ClockIcon className="h-3 w-3" />
                  Previous reliable answer
                </div>
                <MeetingMarkdownText
                  className={cn(
                    WRAP_TEXT_CLASS,
                    "text-[11px] leading-5 text-muted-foreground"
                  )}
                  value={snapshot.latestReliableAnswer}
                />
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function MeetingFocusControlsWindow({
  snapshot,
  sendFocusAction,
}: {
  snapshot: MeetingFocusSnapshot;
  sendFocusAction: (action: MeetingFocusUserAction) => void;
}) {
  const [correction, setCorrection] = useState("");
  const transcriptMeasureRef = useRef<HTMLParagraphElement>(null);
  const lastGeometryRequestRef = useRef("");
  const geometryRevisionRef = useRef(0);
  const interviewTypes = snapshot.interviewTypes;
  const transcriptWindowText = snapshot.latestTurnText;
  const hasCorrectableQuestion = snapshot.hasCorrectableQuestion;
  const activeCorrection =
    snapshot.manualQuestionTypeCorrection &&
    (snapshot.manualQuestionTypeCorrection.taskId === snapshot.activeTask?.id ||
      snapshot.manualQuestionTypeCorrection.questionId ===
        snapshot.currentQuestionId)
      ? snapshot.manualQuestionTypeCorrection
      : undefined;

  const updateInterviewTypes = (type: InterviewBriefType) => {
    const correctionTarget = toCanonicalFocusQuestionType(type);
    if (hasCorrectableQuestion) {
      if (correctionTarget) {
        sendFocusAction({
          type: "correct-question-type",
          correctedType: correctionTarget,
          source: "focus-mode",
        });
      }
      return;
    }

    sendFocusAction({
      type: "update-interview-types",
      interviewTypes: toggleInterviewBriefType(
        interviewTypes,
        type,
        hasCorrectableQuestion
      ),
    });
  };

  const effectiveTypeLabel = formatFocusQuestionType(
    snapshot.effectiveQuestionType
  );
  const correctionRunning =
    activeCorrection?.status === "pending" ||
    activeCorrection?.regenerationStatus === "running";
  const correctionFailed =
    activeCorrection?.status === "failed" ||
    activeCorrection?.regenerationStatus === "failed" ||
    activeCorrection?.regenerationStatus === "cancelled";
  const typeStatusLabel = snapshot.transientPersonalStatusLabel
    ? snapshot.transientPersonalStatusLabel
    : correctionRunning
      ? `Correcting to ${formatFocusQuestionType(
          activeCorrection.correctedType
        )}...`
      : `Q: ${effectiveTypeLabel}`;
  const parentTypeLabel = formatFocusQuestionType(
    snapshot.parentQuestionType
  );
  const typeStatusTitle = [
    typeStatusLabel,
    `authority: ${snapshot.currentQuestionTypeAuthority ?? "unknown"}`,
    `parent: ${parentTypeLabel}${
      snapshot.parentTaskId ? ` (${snapshot.parentTaskId})` : ""
    }`,
    `applied: response=${formatFocusBoolean(
      snapshot.typeAppliedToResponse
    )}, settlement=${formatFocusBoolean(
      snapshot.typeAppliedToSettlement
    )}, parent=${formatFocusBoolean(snapshot.typeAppliedToParent)}`,
    snapshot.durableOwnerMissing
      ? `durable owner missing: ${
          snapshot.durableOwnerMissingReason ?? "unresolved"
        }`
      : undefined,
    correctionFailed
      ? `correction failed: ${activeCorrection?.error ?? "retry available"}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");

  const submitCorrection = () => {
    const trimmed = correction.trim();
    if (!trimmed) return;

    setCorrection("");
    sendFocusAction({ type: "submit-correction", correction: trimmed });
  };

  useLayoutEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const measurement = transcriptMeasureRef.current;
      if (!measurement) return;

      const geometry = resolveFocusControlsGeometry({
        measuredTranscriptHeight: measurement.scrollHeight,
        reservedAuxiliaryHeight: snapshot.speechCorrections.length
          ? FOCUS_CONTROLS_CORRECTION_HISTORY_HEIGHT
          : 0,
      });
      const requestKey = [
        geometry.preferredWidth,
        geometry.preferredHeight,
        geometry.measuredTranscriptHeight,
        geometry.reservedAuxiliaryHeight,
      ].join(":");
      if (lastGeometryRequestRef.current === requestKey) return;

      lastGeometryRequestRef.current = requestKey;
      geometryRevisionRef.current += 1;
      void invoke("set_meeting_focus_controls_geometry", {
        snapshotRevision: geometryRevisionRef.current,
        preferredWidth: geometry.preferredWidth,
        preferredHeight: geometry.preferredHeight,
        measuredTranscriptHeight: geometry.measuredTranscriptHeight,
        transcriptScrollRequired: geometry.transcriptScrollRequired,
      }).catch((error) => {
        console.error(
          "Failed to resize Focus Mode controls for transcript",
          error
        );
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [transcriptWindowText, snapshot.speechCorrections.length]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2">
      <p
        ref={transcriptMeasureRef}
        aria-hidden="true"
        className={cn(
          WRAP_TEXT_CLASS,
          "pointer-events-none fixed -left-[10000px] top-0 text-[13px] leading-5 opacity-0"
        )}
        style={{ width: FOCUS_CONTROLS_TRANSCRIPT_MEASURE_WIDTH }}
      >
        {transcriptWindowText}
      </p>
      <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 p-3 shadow-lg backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <div className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
            Type
          </div>
          <Badge
            variant="outline"
            className={cn(
              "h-7 max-w-[300px] shrink-0 rounded-md px-2 text-[10px]",
              snapshot.durableOwnerMissing &&
                "border-amber-500/70 text-amber-700 dark:text-amber-300"
            )}
            title={typeStatusTitle}
          >
            {correctionRunning ? (
              <Loader2Icon className="mr-1 h-3 w-3 shrink-0 animate-spin" />
            ) : null}
            <span className="truncate">
              {typeStatusLabel} · P: {parentTypeLabel}
            </span>
          </Badge>
          {correctionFailed ? (
            <span
              className="flex shrink-0"
              aria-label="Question type correction failed"
              title={activeCorrection?.error ?? "Question type correction failed"}
            >
              <AlertCircleIcon className="h-4 w-4 text-destructive" />
            </span>
          ) : null}
          <div className="flex min-w-0 flex-nowrap gap-1.5">
            {interviewBriefTypeOptions.map((option) => {
              const selected = hasCorrectableQuestion
                ? toCanonicalFocusQuestionType(option.id) ===
                  snapshot.effectiveQuestionType
                : interviewTypes.includes(option.id);
              return (
                <Button
                  key={option.id}
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  className="h-8 min-w-[64px] shrink-0 px-1.5 text-[10px]"
                  title={option.label}
                  onClick={() => updateInterviewTypes(option.id)}
                >
                  {option.shortLabel}
                </Button>
              );
            })}
            {hasCorrectableQuestion ? (
              <Button
                key="field-knowledge"
                size="sm"
                variant={
                  snapshot.effectiveQuestionType === "field-knowledge"
                    ? "default"
                    : "outline"
                }
                className="h-8 min-w-[64px] shrink-0 px-1.5 text-[10px]"
                title="Field knowledge"
                onClick={() =>
                  sendFocusAction({
                    type: "correct-question-type",
                    correctedType: "field-knowledge",
                    source: "focus-mode",
                  })
                }
              >
                Field
              </Button>
            ) : null}
          </div>
          <Button
            key={snapshot.audioControl.action}
            size="icon"
            variant={snapshot.audioControl.urgent ? "destructive" : "outline"}
            className="ml-auto h-8 w-8 shrink-0"
            title={snapshot.audioControl.title}
            aria-label={snapshot.audioControl.label}
            onClick={() => sendFocusAction({ type: "toggle-listening" })}
            disabled={!snapshot.active || snapshot.audioControl.disabled}
          >
            {snapshot.audioControl.busy ? (
              <Loader2Icon className="h-3 w-3 shrink-0 animate-spin" />
            ) : snapshot.audioControl.action === "pause" ? (
              <PauseIcon className="h-3 w-3 shrink-0" />
            ) : (
              <PlayIcon className="h-3 w-3 shrink-0" />
            )}
          </Button>
          <Badge
            variant="outline"
            className={cn(
              "h-7 shrink-0 rounded-md px-2 text-[10px]",
              snapshot.error ? "border-red-300 text-red-700" : "text-muted-foreground"
            )}
            title={snapshot.error || snapshot.statusLabel}
          >
            {snapshot.error ? "Error" : snapshot.statusLabel}
          </Badge>
        </div>

        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/20 px-3 py-2">
            <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <MessageSquareTextIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Latest transcript</span>
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  "ml-auto h-7 shrink-0 gap-1 px-2 text-[10px]",
                  !snapshot.forceAdviseAvailable &&
                    "cursor-not-allowed opacity-50"
                )}
                onClick={() => sendFocusAction({ type: "force-advise" })}
                aria-disabled={!snapshot.forceAdviseAvailable}
                title={
                  snapshot.forceAdviseAvailable
                    ? "Force one advisor response for this transcript"
                    : snapshot.forceAdvisePending
                      ? "Advisor repair is running"
                      : snapshot.forceAdviseCompleted
                        ? "This transcript has already been advised"
                        : "No recoverable interviewer turn is available"
                }
              >
                {snapshot.forceAdvisePending ? (
                  <Loader2Icon className="h-3 w-3 animate-spin" />
                ) : (
                  <BrainIcon className="h-3 w-3" />
                )}
                {snapshot.forceAdvisePending
                  ? "Advising"
                  : snapshot.forceAdviseCompleted
                    ? "Advised"
                    : "Advise"}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <p
                className={cn(
                  WRAP_TEXT_CLASS,
                  "text-[13px] leading-5 text-muted-foreground"
                )}
              >
                {snapshot.latestTurnText}
              </p>
            </div>
          </div>

          <div className="mt-auto min-w-0 shrink-0">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              Correction
            </div>
            <div className="flex min-w-0 gap-1.5">
              <Input
                value={correction}
                onChange={(event) => setCorrection(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitCorrection();
                  }
                }}
                placeholder="Correction: RAG not rec / Glean"
                className="h-9 min-w-0 text-[12px]"
                disabled={!snapshot.active}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-9 shrink-0 gap-1 px-3 text-[11px]"
                onClick={submitCorrection}
                disabled={!snapshot.active || !correction.trim()}
              >
                <SendIcon className="h-3 w-3" />
                Apply
              </Button>
            </div>

            {snapshot.speechCorrections.length ? (
              <div className="mt-1.5 grid h-6 min-w-0 grid-cols-2 gap-1 overflow-hidden">
                {snapshot.speechCorrections.slice(-2).map((item) => (
                  <Badge
                    key={item.id}
                    variant="outline"
                    className={cn(
                      "flex min-w-0 items-center gap-1 overflow-hidden rounded-sm px-1.5 py-0 text-[10px]",
                      item.deactivatedAt && "opacity-55"
                    )}
                    title={
                      item.activeQuestion?.error
                        ? `${item.input}: ${item.activeQuestion.error}`
                        : item.input
                    }
                  >
                    {item.activeQuestion?.regenerationStatus === "running" ? (
                      <Loader2Icon className="h-2.5 w-2.5 shrink-0 animate-spin" />
                    ) : null}
                    <span className="truncate">
                      {item.from && item.to
                        ? `${item.from} -> ${item.to}`
                        : item.term || item.to}
                      {item.appliedCount ? ` x${item.appliedCount}` : ""}
                      {item.activeQuestion
                        ? ` · ${formatFocusTermCorrectionStatus(
                            item.activeQuestion.disposition,
                            item.activeQuestion.regenerationStatus
                          )}`
                        : ""}
                      {item.deactivatedAt ? " · stopped" : ""}
                    </span>
                    {!item.deactivatedAt ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-4 w-4 shrink-0 p-0"
                        title="Stop future replacement"
                        aria-label={`Stop correction ${item.from ?? item.term ?? item.to ?? item.id}`}
                        onClick={() =>
                          sendFocusAction({
                            type: "deactivate-correction",
                            correctionId: item.id,
                          })
                        }
                      >
                        <XIcon className="h-2.5 w-2.5" />
                      </Button>
                    ) : null}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatFocusTermCorrectionStatus(
  disposition: NonNullable<
    MeetingFocusSnapshot["speechCorrections"][number]["activeQuestion"]
  >["disposition"],
  regenerationStatus: NonNullable<
    MeetingFocusSnapshot["speechCorrections"][number]["activeQuestion"]
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

function FocusClarifyingActionButtons({
  snapshot,
  sendFocusAction,
}: {
  snapshot: MeetingFocusSnapshot;
  sendFocusAction: (action: MeetingFocusUserAction) => void;
}) {
  const sendClarifyingAnswer = (answer: ClarifyingQuestionAnswer, option?: { label?: string; value?: string }) =>
    sendFocusAction({ type: "clarifying-answer", answer, option });
  const options = snapshot.sections.clarifyingOptions;
  const selectedAnswerLabel = snapshot.selectedClarifyingAnswerLabel;
  const selectionPending = snapshot.clarifyingSelectionState === "pending";

  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {snapshot.isTaskSwitchClarifyingQuestion ||
        snapshot.showClarifyingBooleanFallback ? (
          <>
            <FocusClarifyingButton
              icon={<CheckIcon className="h-3 w-3 shrink-0" />}
              label={
                snapshot.isTaskSwitchClarifyingQuestion ? "New task" : "Yes"
              }
              selected={selectedAnswerLabel === "New task" || selectedAnswerLabel === "Yes"}
              disabled={snapshot.isBusy || selectionPending}
              onClick={() => {
                if (snapshot.isTaskSwitchClarifyingQuestion) {
                  sendFocusAction({ type: "new-task" });
                  return;
                }
                sendClarifyingAnswer("yes");
              }}
            />
            <FocusClarifyingButton
              icon={<XIcon className="h-3 w-3 shrink-0" />}
              label={snapshot.isTaskSwitchClarifyingQuestion ? "Same task" : "No"}
              selected={selectedAnswerLabel === "Same task" || selectedAnswerLabel === "No"}
              disabled={snapshot.isBusy || selectionPending}
              onClick={() => {
                if (snapshot.isTaskSwitchClarifyingQuestion) {
                  sendFocusAction({ type: "same-task" });
                  return;
                }
                sendClarifyingAnswer("no");
              }}
            />
          </>
        ) : options.length ? (
          options.slice(0, 4).map((option) => (
            <FocusClarifyingButton
              key={option.id}
              label={option.label}
              title={option.label}
              selected={selectedAnswerLabel === option.label}
              disabled={snapshot.isBusy || selectionPending}
              onClick={() => {
                sendClarifyingAnswer("option", {
                  label: option.label,
                  value: option.value,
                });
              }}
            />
          ))
        ) : null}
        <FocusClarifyingButton
          label="Not sure"
          selected={selectedAnswerLabel === "Not sure"}
          disabled={snapshot.isBusy || selectionPending}
          onClick={() => sendClarifyingAnswer("not-sure")}
        />
        <FocusClarifyingButton
          label="Dismiss"
          disabled={snapshot.isBusy || selectionPending}
          onClick={() => sendFocusAction({ type: "dismiss-clarifying-question" })}
        />
      </div>
      {selectedAnswerLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 rounded-sm bg-primary/10 px-2 py-1 text-[10px] text-primary">
          {selectionPending ? (
            <Loader2Icon className="h-3 w-3 animate-spin" />
          ) : snapshot.clarifyingSelectionState === "succeeded" ? (
            <CheckIcon className="h-3 w-3" />
          ) : null}
          <span className="min-w-0 truncate">
            {snapshot.clarifyingSelectionMessage ??
              `Selected: ${selectedAnswerLabel}.`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function FocusClarifyingButton({
  label,
  title,
  icon,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  title?: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={selected ? "default" : "outline"}
      className="h-auto min-h-8 min-w-0 gap-1 px-2 py-1.5 text-[10px] leading-3"
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
    >
      {icon}
      <span className="min-w-0 whitespace-normal break-words text-left">
        {label}
      </span>
    </Button>
  );
}


function toggleInterviewBriefType(
  currentTypes: readonly InterviewBriefType[],
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

function toCanonicalFocusQuestionType(
  type: InterviewBriefType
): CanonicalQuestionType | undefined {
  if (type === "mixed") return undefined;
  return type === "system-design" ? "general-system-design" : type;
}

function formatFocusQuestionType(type: string | undefined) {
  if (type === "behavioral") return "Behavioral";
  if (type === "coding") return "Coding";
  if (type === "general-system-design") return "General SD";
  if (type === "ai-ml-system-design") return "AI/ML SD";
  if (type === "project-deep-dive") return "Project";
  if (type === "field-knowledge") return "Field Knowledge";
  return "Unknown";
}

function formatFocusBoolean(value: boolean | undefined) {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}
