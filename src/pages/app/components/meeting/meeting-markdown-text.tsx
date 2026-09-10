import { Markdown } from "@/components";
import { cn } from "@/lib/utils";
import { normalizeMeetingMarkdown } from "@/lib/meeting/meeting-display-text";

export function MeetingMarkdownText({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("meeting-assistant-markdown min-w-0 w-full max-w-full overflow-x-hidden text-xs leading-5 [&_code]:text-[10px] [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-2 [&_pre]:max-h-72 [&_pre]:overflow-auto [&_strong]:font-semibold [&_ul]:my-1", className)}>
      <Markdown>{normalizeMeetingMarkdown(value)}</Markdown>
    </div>
  );
}
