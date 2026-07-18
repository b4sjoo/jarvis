import {
  Badge,
  Button,
  Input,
  Markdown,
  ScrollArea,
} from "@/components";
import type {
  CanonicalQuestionType,
  ClarifyingQuestionAnswer,
  InterviewBriefType,
  MeetingFocusAction,
  MeetingFocusSnapshot,
  MeetingFocusWindowKind,
} from "@/lib/meeting";
import {
  EMPTY_MEETING_FOCUS_SNAPSHOT,
  MEETING_FOCUS_ACTION_EVENT,
  MEETING_FOCUS_SNAPSHOT_EVENT,
  stripOuterCodeFence,
} from "@/lib/meeting";
import { cn } from "@/lib/utils";
import { emit, listen } from "@tauri-apps/api/event";
import {
  BrainIcon,
  CheckIcon,
  ClockIcon,
  Code2Icon,
  FileTextIcon,
  HelpCircleIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

const WRAP_TEXT_CLASS =
  "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
const CHINESE_THINKING_TEXT_CLASS =
  "min-w-0 break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere] [&_*]:leading-5 [&_li]:my-0 [&_ol]:my-0 [&_p]:my-0 [&_p+p]:mt-1 [&_ul]:my-0";
const MEETING_MARKDOWN_CLASS =
  "text-xs leading-5 [&_code]:text-[10px] [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-2 [&_pre]:max-h-72 [&_pre]:overflow-auto [&_strong]:font-semibold [&_ul]:my-1";

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
  { id: "mixed", label: "Mixed", shortLabel: "Mixed" },
];

const concreteInterviewBriefTypes = interviewBriefTypeOptions
  .map((option) => option.id)
  .filter((type): type is Exclude<InterviewBriefType, "mixed"> => type !== "mixed");

export function MeetingFocusWindow({ kind }: { kind: MeetingFocusWindowKind }) {
  const [snapshot, setSnapshot] = useState<MeetingFocusSnapshot>(
    EMPTY_MEETING_FOCUS_SNAPSHOT
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<MeetingFocusSnapshot>(
        MEETING_FOCUS_SNAPSHOT_EVENT,
        (event) => {
          setSnapshot(event.payload);
        }
      );
      sendFocusAction({ type: "request-snapshot" });
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, []);

  if (kind === "controls") {
    return <MeetingFocusControlsWindow snapshot={snapshot} />;
  }

  return <MeetingFocusAnswerWindow snapshot={snapshot} />;
}

function MeetingFocusAnswerWindow({
  snapshot,
}: {
  snapshot: MeetingFocusSnapshot;
}) {
  const sections = snapshot.sections;
  const focusAnswer = sections.primaryAnswer;
  const focusThinking =
    sections.chineseThinking || "等待 Jarvis 给出中文思路。";

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 shadow-lg backdrop-blur">
        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
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
              </div>
              <MeetingMarkdownText
                className={cn(WRAP_TEXT_CLASS, "min-h-20 text-sm leading-6")}
                value={focusAnswer || "Waiting for answer."}
              />
            </section>

            {sections.whiteboard ? (
              <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-muted/20 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <FileTextIcon className="h-3.5 w-3.5" />
                  Whiteboard
                </div>
                <MeetingMarkdownText
                  className={cn(WRAP_TEXT_CLASS, "text-xs leading-5")}
                  value={sections.whiteboard}
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
                <FocusClarifyingActionButtons snapshot={snapshot} />
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
}: {
  snapshot: MeetingFocusSnapshot;
}) {
  const [correction, setCorrection] = useState("");
  const interviewTypes = snapshot.interviewTypes;
  const hasActiveTask = Boolean(snapshot.activeTask);
  const activeCorrection =
    snapshot.manualQuestionTypeCorrection?.taskId === snapshot.activeTask?.id
      ? snapshot.manualQuestionTypeCorrection
      : undefined;

  const updateInterviewTypes = (type: InterviewBriefType) => {
    const correctionTarget = toCanonicalFocusQuestionType(type);
    if (hasActiveTask) {
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
        hasActiveTask
      ),
    });
  };

  const effectiveTypeLabel = formatFocusQuestionType(
    snapshot.effectiveQuestionType
  );
  const correctionRunning =
    activeCorrection?.status === "pending" ||
    activeCorrection?.regenerationStatus === "running";
  const typeStatusLabel = correctionRunning
    ? `Correcting to ${formatFocusQuestionType(
        activeCorrection.correctedType
      )}...`
    : activeCorrection?.regenerationStatus === "failed"
      ? `Corrected: ${formatFocusQuestionType(
          activeCorrection.correctedType
        )} · retry failed`
      : `Current: ${effectiveTypeLabel}${
          snapshot.questionTypeCorrected ? " · corrected" : ""
        }`;
  const typeStatusTitle = snapshot.activeTask?.child
    ? `${typeStatusLabel}; parent: ${formatFocusQuestionType(
        snapshot.activeTask.questionType
      )}`
    : typeStatusLabel;

  const submitCorrection = () => {
    const trimmed = correction.trim();
    if (!trimmed) return;

    setCorrection("");
    sendFocusAction({ type: "submit-correction", correction: trimmed });
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2">
      <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background/95 p-3 shadow-lg backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <div className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
            Type
          </div>
          <Badge
            variant="outline"
            className="h-7 max-w-[180px] shrink-0 rounded-md px-2 text-[10px]"
            title={typeStatusTitle}
          >
            {correctionRunning ? (
              <Loader2Icon className="mr-1 h-3 w-3 shrink-0 animate-spin" />
            ) : null}
            <span className="truncate">{typeStatusLabel}</span>
          </Badge>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {interviewBriefTypeOptions
              .filter((option) => !hasActiveTask || option.id !== "mixed")
              .map((option) => {
                const selected = hasActiveTask
                  ? toCanonicalFocusQuestionType(option.id) ===
                    snapshot.effectiveQuestionType
                  : interviewTypes.includes(option.id);
                return (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    className="h-8 min-w-[88px] shrink-0 px-3 text-[10px]"
                    title={option.label}
                    onClick={() => updateInterviewTypes(option.id)}
                    disabled={correctionRunning}
                  >
                    {option.shortLabel}
                  </Button>
                );
              })}
          </div>
          <Badge
            variant="outline"
            className={cn(
              "ml-auto h-7 shrink-0 rounded-md px-2 text-[10px]",
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
            </div>
            <p
              className={cn(
                WRAP_TEXT_CLASS,
                "line-clamp-3 text-[13px] leading-5 text-muted-foreground"
              )}
            >
              {snapshot.latestTurnText}
            </p>
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
              <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                {snapshot.speechCorrections.slice(-4).map((item) => (
                  <Badge
                    key={item.id}
                    variant="outline"
                    className="max-w-full rounded-sm px-1.5 py-0 text-[10px]"
                    title={item.input}
                  >
                    <span className="truncate">
                      {item.from && item.to
                        ? `${item.from} -> ${item.to}`
                        : item.term || item.to}
                      {item.appliedCount ? ` x${item.appliedCount}` : ""}
                    </span>
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

function FocusClarifyingActionButtons({
  snapshot,
}: {
  snapshot: MeetingFocusSnapshot;
}) {
  const options = snapshot.sections.clarifyingOptions;
  const selectedAnswerLabel = snapshot.selectedClarifyingAnswerLabel;

  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {snapshot.isTaskSwitchClarifyingQuestion || options.length < 2 ? (
          <>
            <FocusClarifyingButton
              icon={<CheckIcon className="h-3 w-3 shrink-0" />}
              label={
                snapshot.isTaskSwitchClarifyingQuestion ? "New task" : "Yes"
              }
              selected={selectedAnswerLabel === "New task" || selectedAnswerLabel === "Yes"}
              disabled={snapshot.isBusy}
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
              disabled={snapshot.isBusy}
              onClick={() => {
                if (snapshot.isTaskSwitchClarifyingQuestion) {
                  sendFocusAction({ type: "same-task" });
                  return;
                }
                sendClarifyingAnswer("no");
              }}
            />
          </>
        ) : (
          options.slice(0, 4).map((option) => (
            <FocusClarifyingButton
              key={option.id}
              label={option.label}
              title={option.label}
              selected={selectedAnswerLabel === option.label}
              disabled={snapshot.isBusy}
              onClick={() => {
                sendClarifyingAnswer("option", {
                  label: option.label,
                  value: option.value,
                });
              }}
            />
          ))
        )}
        <FocusClarifyingButton
          label="Not sure"
          selected={selectedAnswerLabel === "Not sure"}
          disabled={snapshot.isBusy}
          onClick={() => sendClarifyingAnswer("not-sure")}
        />
        <FocusClarifyingButton
          label="Dismiss"
          disabled={snapshot.isBusy}
          onClick={() => sendFocusAction({ type: "dismiss-clarifying-question" })}
        />
      </div>
      {selectedAnswerLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 rounded-sm bg-primary/10 px-2 py-1 text-[10px] text-primary">
          {snapshot.isBusy ? (
            <Loader2Icon className="h-3 w-3 animate-spin" />
          ) : null}
          <span className="min-w-0 truncate">
            Selected: {selectedAnswerLabel}. Jarvis is updating.
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

function MeetingMarkdownText({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <div className={cn(MEETING_MARKDOWN_CLASS, className)}>
      <Markdown>{normalizeMeetingMarkdown(value)}</Markdown>
    </div>
  );
}

function sendClarifyingAnswer(
  answer: ClarifyingQuestionAnswer,
  option?: { label?: string; value?: string }
) {
  sendFocusAction({ type: "clarifying-answer", answer, option });
}

function sendFocusAction(action: MeetingFocusAction) {
  void emit(MEETING_FOCUS_ACTION_EVENT, action);
}

function toggleInterviewBriefType(
  currentTypes: InterviewBriefType[],
  type: InterviewBriefType,
  forceSingleConcrete = false
): InterviewBriefType[] {
  const current = new Set(currentTypes);

  if (type === "mixed") {
    const allSelected = concreteInterviewBriefTypes.every((candidate) =>
      current.has(candidate)
    );
    return allSelected ? [] : [...concreteInterviewBriefTypes, "mixed"];
  }

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
  const allConcreteSelected =
    concreteTypes.length === concreteInterviewBriefTypes.length;

  return allConcreteSelected ? [...concreteTypes, "mixed"] : concreteTypes;
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

function formatChineseThinkingText(value: string) {
  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n");
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
    .replace(/\\times/g, "x")
    .replace(/\\cdot/g, "*")
    .replace(/\\log/g, "log")
    .replace(/\\text\{([^}]+)\}/g, "$1")
    .replace(/\s+/g, " ");
}
