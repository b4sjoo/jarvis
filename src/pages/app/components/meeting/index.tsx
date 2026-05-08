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
  const isBusy =
    meeting.status === "starting" ||
    meeting.status === "transcribing" ||
    meeting.status === "thinking";
  const isListening = meeting.status === "listening";

  const title = useMemo(() => {
    if (meeting.error) return meeting.error;
    if (isListening) return "Stop meeting assistant";
    return "Start meeting assistant";
  }, [isListening, meeting.error]);

  const handleToggle = async () => {
    setOpen(true);
    if (isListening || isBusy) {
      await meeting.stop();
    } else {
      await meeting.start();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant={isListening ? "default" : "outline"}
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
          ) : (
            <BrainIcon className="h-4 w-4" />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-screen p-0 border-input/50 overflow-hidden"
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
                  isListening && "border-green-300 text-green-700",
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
                disabled={isBusy}
              >
                <CameraIcon className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant={isListening || isBusy ? "destructive" : "default"}
                className="h-8 w-8"
                title={isListening || isBusy ? "Stop" : "Start"}
                onClick={handleToggle}
              >
                {isListening || isBusy ? (
                  <SquareIcon className="h-4 w-4" />
                ) : (
                  <PlayIcon className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-3">
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
                  {latestTurn?.text || "Start listening to see meeting audio here."}
                </p>
              </section>

              <section className="rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                  <BrainIcon className="h-3.5 w-3.5" />
                  Suggestion
                </div>
                <p className="min-h-24 whitespace-pre-wrap text-xs leading-5">
                  {displaySuggestion ||
                    "Suggestions will appear after a complete colleague turn is transcribed."}
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
            <Button
              size="sm"
              variant={isListening || isBusy ? "destructive" : "default"}
              className="h-8 gap-1.5 text-xs"
              onClick={handleToggle}
            >
              {isListening || isBusy ? (
                <SquareIcon className="h-3.5 w-3.5" />
              ) : (
                <PlayIcon className="h-3.5 w-3.5" />
              )}
              {isListening || isBusy ? "Stop" : "Start"}
            </Button>
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
