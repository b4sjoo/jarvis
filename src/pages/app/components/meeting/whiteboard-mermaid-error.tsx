import type { MermaidErrorComponentProps } from "streamdown";
import { buildWhiteboardAsciiFallback } from "@/lib/meeting";

export function WhiteboardMermaidError({
  chart,
}: MermaidErrorComponentProps) {
  const fallback = buildWhiteboardAsciiFallback(
    ["```mermaid", chart, "```"].join("\n")
  );
  return (
    <pre className="my-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/70 bg-muted/50 p-2 font-mono text-[11px] leading-4 text-foreground">
      {fallback.content}
    </pre>
  );
}
