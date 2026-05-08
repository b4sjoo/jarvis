import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from "@/components";
import { useMeetingAssistant } from "@/hooks";
import { cn } from "@/lib/utils";
import {
  BrainIcon,
  CameraIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  SquareIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

const statusLabel = {
  idle: "Ready",
  starting: "Starting",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  paused: "Paused",
  error: "Needs attention",
};

export const MeetingAssistant = () => {
  const meeting = useMeetingAssistant();
  const [open, setOpen] = useState(false);

  const latestTurn =
    meeting.transcriptTurns[meeting.transcriptTurns.length - 1];
  const displaySuggestion =
    meeting.partialSuggestion || meeting.latestSuggestion?.content || "";
  const suggestionSections = useMemo(
    () => parseSuggestionSections(displaySuggestion),
    [displaySuggestion]
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

  const title = useMemo(() => {
    if (meeting.error) return meeting.error;
    if (isPaused) return "Resume meeting assistant";
    if (isRunning || meeting.status === "starting") {
      return "Stop meeting assistant";
    }
    return "Start meeting assistant";
  }, [isPaused, isRunning, meeting.error, meeting.status]);

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant={isRunning ? "default" : "outline"}
          title={title}
          onClick={handleToggle}
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
        className="w-screen overflow-hidden border-input/50 p-0"
      >
        <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
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
                onClick={meeting.captureScreenContext}
                disabled={meeting.status === "starting"}
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

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-3">
              {meeting.setupWarnings.length > 0 ? (
                <section className="rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="text-xs font-medium text-amber-900">
                    Setup
                  </div>
                  <div className="mt-1 space-y-1">
                    {meeting.setupWarnings.map((warning) => (
                      <div
                        key={warning.code}
                        className={cn(
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
                <section className="rounded-md border border-red-200 bg-red-50 p-3">
                  <div className="text-xs font-medium text-red-800">Error</div>
                  <div className="mt-1 text-xs text-red-700">
                    {meeting.error}
                  </div>
                </section>
              ) : null}

              <section className="rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Latest transcript
                </div>
                <p className="min-h-10 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                  {latestTurn?.text || "Waiting for meeting audio."}
                </p>
              </section>

              <section className="rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <BrainIcon className="h-3.5 w-3.5" />
                  Meaning
                </div>
                <p className="min-h-14 whitespace-pre-wrap text-xs leading-5">
                  {suggestionSections.meaning || "Waiting for context."}
                </p>
              </section>

              <section className="rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Suggested reply
                </div>
                <p className="min-h-20 whitespace-pre-wrap text-xs leading-5">
                  {suggestionSections.reply || "Waiting for suggestion."}
                </p>
              </section>

              <section className="rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <MessageSquareTextIcon className="h-3.5 w-3.5" />
                  Clarifying question
                </div>
                <p className="min-h-14 whitespace-pre-wrap text-xs leading-5">
                  {suggestionSections.question || "Not needed yet."}
                </p>
              </section>

              <section className="grid grid-cols-2 gap-2">
                <Metric label="Turns" value={meeting.transcriptTurns.length} />
                <Metric
                  label="Screen"
                  value={meeting.screenObservations.length}
                />
              </section>
            </div>
          </ScrollArea>

          <div className="flex items-center justify-between gap-2 border-t border-border/50 p-2">
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
            <div className="flex items-center gap-1.5">
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

const Metric = ({ label, value }: { label: string; value: number }) => {
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
};

const sectionBoundaryLabels = [
  "Meaning",
  "Reply",
  "Suggested reply",
  "Question",
  "Clarifying question",
];

function parseSuggestionSections(content: string) {
  const trimmedContent = sanitizeSectionText(content);

  if (!trimmedContent) {
    return {
      meaning: "",
      reply: "",
      question: "",
    };
  }

  const meaning = readSuggestionSection(trimmedContent, ["Meaning"]);
  const reply = readSuggestionSection(trimmedContent, [
    "Reply",
    "Suggested reply",
  ]);
  const question = readSuggestionSection(trimmedContent, [
    "Question",
    "Clarifying question",
  ]);
  const hasStructuredSections = Boolean(meaning || reply || question);

  return {
    meaning,
    reply: reply || (hasStructuredSections ? "" : trimmedContent),
    question,
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
