import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { Markdown } from "../../src/components/Markdown";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../src/components/ui/popover";
import { ScrollArea } from "../../src/components/ui/scroll-area";
import { parseMeetingAnswer } from "../../src/lib/meeting/meeting-answer";
import { WhiteboardViewer } from "../../src/pages/app/components/meeting/whiteboard-viewer";
import "../../src/global.css";

interface WidthMeasurement {
  label: string;
  tag: string;
  className: string;
  clientWidth: number;
  scrollWidth: number;
  display: string;
  overflowX: string;
  whiteSpace: string;
}

declare global {
  interface Window {
    __TASK192_MEASURE__?: {
      width: number;
      panel: WidthMeasurement;
      overflow: WidthMeasurement[];
    };
  }
}

const MEETING_MARKDOWN_CLASS =
  "meeting-assistant-markdown min-w-0 w-full max-w-full overflow-x-hidden text-xs leading-5 [&_code]:text-[10px] [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-2 [&_pre]:max-h-72 [&_pre]:overflow-auto [&_strong]:font-semibold [&_ul]:my-1";

function MeetingMarkdownText({ value }: { value: string }) {
  return (
    <div className={MEETING_MARKDOWN_CLASS} data-measure="markdown">
      <Markdown>{normalizeMeetingMarkdown(value)}</Markdown>
    </div>
  );
}

function SuggestionBlock({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <MeetingMarkdownText value={value} />
    </div>
  );
}

function WidthFixture() {
  const [raw, setRaw] = useState("");
  const width = window.innerWidth;
  useEffect(() => {
    void fetch("/tests/fixtures/task-192-screen-output.md")
      .then((response) => response.text())
      .then(setRaw);
  }, []);
  const answer = useMemo(() => parseMeetingAnswer(raw), [raw]);
  const sections = answer.sections;

  useEffect(() => {
    if (!raw) return;
    const timer = window.setTimeout(() => {
      const panel = document.querySelector<HTMLElement>(
        '[data-measure="panel"]'
      );
      if (!panel) return;
      const candidates = [panel, ...panel.querySelectorAll<HTMLElement>("*")];
      const measurements = candidates.map(measureElement);
      window.__TASK192_MEASURE__ = {
        width,
        panel: measureElement(panel),
        overflow: measurements.filter(
          (measurement) =>
            measurement.scrollWidth > measurement.clientWidth + 1
        ),
      };
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [raw, width]);

  if (!raw) return <div>Loading fixture...</div>;

  return (
    <Popover open>
      <PopoverTrigger asChild>
        <button type="button">Open fixture</button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[920px] max-w-[100vw] overflow-hidden border-input/50 p-0"
        data-measure="panel"
        side="bottom"
        sideOffset={8}
      >
        <div className="flex h-[calc(100vh-4rem)] w-full max-w-full flex-col overflow-hidden">
          <ScrollArea
            className="meeting-assistant-main-scroll min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
            data-measure="scroll-root"
          >
            <div
              className="min-w-0 max-w-full space-y-3 overflow-x-hidden p-3"
              data-measure="content"
            >
          <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-primary/5 p-3">
            <SuggestionBlock label="Answer" value={sections.answer ?? ""} />
          </section>

          {sections.whiteboard ? (
            <section className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-muted/20 p-3">
              <div className="mb-2 text-xs font-semibold">Whiteboard</div>
              <WhiteboardViewer
                value={sections.whiteboard}
                viewKey="task-192-recorded-output"
              />
            </section>
          ) : null}

          <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
            <div className="space-y-2">
              <SuggestionBlock
                label="Question"
                value={sections.question ?? ""}
              />
              <SuggestionBlock
                label="Approach"
                value={sections.approach ?? ""}
              />
            </div>
          </section>

          <section className="min-w-0 overflow-hidden rounded-md border border-border/70 p-3">
            <SuggestionBlock
              label="Clarifying question"
              value={sections.clarifyingQuestion ?? ""}
            />
            <div
              className="mt-3 grid min-w-0 grid-cols-2 gap-1.5"
              data-measure="clarifying-options"
            >
              {(sections.clarifyingOptions ?? []).map((option) => (
                <button
                  className="h-auto min-h-8 min-w-0 px-2 py-1.5 text-[10px] leading-3"
                  key={option.id}
                  type="button"
                >
                  <span className="min-w-0 whitespace-normal break-words text-left">
                    {option.label}
                  </span>
                </button>
              ))}
            </div>
          </section>
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function measureElement(element: HTMLElement): WidthMeasurement {
  const style = window.getComputedStyle(element);
  return {
    label:
      element.dataset.measure ??
      element.dataset.slot ??
      element.dataset.streamdown ??
      element.id ??
      element.tagName.toLowerCase(),
    tag: element.tagName.toLowerCase(),
    className:
      typeof element.className === "string"
        ? element.className.slice(0, 180)
        : element.getAttribute("class")?.slice(0, 180) ?? "",
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    display: style.display,
    overflowX: style.overflowX,
    whiteSpace: style.whiteSpace,
  };
}

function normalizeMeetingMarkdown(value: string) {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map((segment) =>
      segment.startsWith("```")
        ? segment
        : normalizeMeetingMathText(segment)
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
    .replace(
      /(^|[^\\$])\$([^$\n]+?)\$/g,
      (_, prefix: string, expression: string) =>
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

createRoot(document.getElementById("root")!).render(<WidthFixture />);
