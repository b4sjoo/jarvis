import { useState } from "react";
import {
  InfoIcon,
  ChevronDownIcon,
  AudioWaveformIcon,
  MicIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface WarningProps {
  isVadMode: boolean;
}

export const Warning = ({ isVadMode }: WarningProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <InfoIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Help</span>
        </div>
        <ChevronDownIcon
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform",
            isExpanded && "rotate-180"
          )}
        />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Current Mode Info */}
          <div className="flex items-start gap-2 p-2 rounded-md bg-primary/5">
            {isVadMode ? (
              <AudioWaveformIcon className="w-4 h-4 text-primary mt-0.5" />
            ) : (
              <MicIcon className="w-4 h-4 text-primary mt-0.5" />
            )}
            <div>
              <p className="text-xs font-medium">
                {isVadMode ? "Auto-detect Mode" : "Manual Mode"}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {isVadMode
                  ? "Speech is automatically detected from system audio. When someone speaks, it will be captured and transcribed."
                  : "Press the record button or use keyboard shortcuts to manually control recording."}
              </p>
            </div>
          </div>

          {/* Tips */}
          <div className="text-[10px] text-muted-foreground space-y-1 pt-2 border-t border-border/50">
            <p>
              <strong>Tip:</strong> Use Auto-detect for hands-free operation
              during interviews.
            </p>
            <p>
              <strong>Tip:</strong> Use Manual mode when you need precise
              control over what gets transcribed.
            </p>
            <p>
              <strong>Tip:</strong> Quick Actions let you send follow-up prompts
              with one click.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
