import { Button, Markdown } from "@/components";
import {
  WHITEBOARD_VIEWPORT_MAX_ZOOM,
  WHITEBOARD_VIEWPORT_MIN_ZOOM,
  WHITEBOARD_VIEWPORT_ZOOM_STEP,
  clampWhiteboardViewportOffset,
  clampWhiteboardViewportZoom,
  hasMermaidWhiteboard,
  type WhiteboardViewportOffset,
} from "@/lib/meeting";
import { cn } from "@/lib/utils";
import {
  Maximize2Icon,
  Minimize2Icon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { WhiteboardMermaidError } from "./whiteboard-mermaid-error";

const WHITEBOARD_MARKDOWN_CLASS =
  "min-w-0 whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere] [&_code]:text-[10px] [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-0 [&_pre]:my-2 [&_pre]:overflow-auto [&_strong]:font-semibold [&_ul]:my-1";
const WHITEBOARD_MARKDOWN_CONTROLS = {
  table: true,
  code: true,
  mermaid: false,
} as const;
const PAN_STEP = 48;

interface WhiteboardViewerProps {
  value: string;
  viewKey?: string;
  className?: string;
}

interface DragState {
  pointerId: number;
  clientX: number;
  clientY: number;
  offset: WhiteboardViewportOffset;
}

export function WhiteboardViewer({
  value,
  viewKey,
  className,
}: WhiteboardViewerProps) {
  const isMermaid = hasMermaidWhiteboard(value);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [zoom, setZoom] = useState(WHITEBOARD_VIEWPORT_MIN_ZOOM);
  const [offset, setOffset] = useState<WhiteboardViewportOffset>({
    x: 0,
    y: 0,
  });
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const resetKey = viewKey ?? value;

  const clampOffset = useCallback(
    (candidate: WhiteboardViewportOffset, candidateZoom = zoom) => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return candidate;

      return clampWhiteboardViewportOffset(candidate, {
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        contentWidth: content.scrollWidth,
        contentHeight: content.scrollHeight,
        zoom: candidateZoom,
      });
    },
    [zoom]
  );

  const updateZoom = useCallback(
    (nextZoom: number) => {
      const clampedZoom = clampWhiteboardViewportZoom(nextZoom);
      setZoom(clampedZoom);
      setOffset((current) => clampOffset(current, clampedZoom));
    },
    [clampOffset]
  );

  const resetViewport = useCallback(() => {
    setZoom(WHITEBOARD_VIEWPORT_MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setExpanded(false);
    setDragging(false);
    dragRef.current = null;
    resetViewport();
  }, [resetKey, resetViewport]);

  useEffect(() => {
    if (!expanded) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [expanded]);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setOffset((current) => clampOffset(current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [clampOffset, expanded, zoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      setOffset((current) => clampOffset(current));
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [clampOffset, expanded]);

  const panBy = useCallback(
    (x: number, y: number) => {
      setOffset((current) =>
        clampOffset({ x: current.x + x, y: current.y + y })
      );
    },
    [clampOffset]
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offset,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    setOffset(
      clampOffset({
        x: drag.offset.x + event.clientX - drag.clientX,
        y: drag.offset.y + event.clientY - drag.clientY,
      })
    );
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      updateZoom(zoom + WHITEBOARD_VIEWPORT_ZOOM_STEP);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      updateZoom(zoom - WHITEBOARD_VIEWPORT_ZOOM_STEP);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      resetViewport();
      return;
    }

    const pan = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    }[event.key];
    if (!pan) return;
    event.preventDefault();
    panBy(pan[0], pan[1]);
  };

  if (!isMermaid) {
    return (
      <div className={cn(WHITEBOARD_MARKDOWN_CLASS, className)}>
        <Markdown mermaidErrorComponent={WhiteboardMermaidError}>
          {value}
        </Markdown>
      </div>
    );
  }

  const viewer = (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        expanded ? "h-full" : className
      )}
    >
      <WhiteboardToolbar
        expanded={expanded}
        zoom={zoom}
        onExpand={() => setExpanded((current) => !current)}
        onReset={resetViewport}
        onZoomIn={() =>
          updateZoom(zoom + WHITEBOARD_VIEWPORT_ZOOM_STEP)
        }
        onZoomOut={() =>
          updateZoom(zoom - WHITEBOARD_VIEWPORT_ZOOM_STEP)
        }
      />
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 overflow-hidden rounded-sm border border-border/60 bg-background/80 outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          expanded ? "flex-1" : "h-72"
        )}
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction:
            zoom > WHITEBOARD_VIEWPORT_MIN_ZOOM ? "none" : "pan-y",
        }}
        role="application"
        aria-label="Interactive whiteboard diagram"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerCancel={finishPointerDrag}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
      >
        <div
          ref={contentRef}
          className={cn(
            WHITEBOARD_MARKDOWN_CLASS,
            "min-w-full origin-top-left select-none p-2 [&_[data-streamdown=mermaid-block]]:pointer-events-none"
          )}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: "top left",
            willChange: "transform",
          }}
        >
          <Markdown
            controls={WHITEBOARD_MARKDOWN_CONTROLS}
            mermaidErrorComponent={WhiteboardMermaidError}
          >
            {value}
          </Markdown>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {expanded ? (
        <div className="flex h-24 items-center justify-center rounded-sm border border-dashed border-border/70 text-[11px] text-muted-foreground">
          Whiteboard is open in the expanded view.
        </div>
      ) : (
        viewer
      )}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-[100] bg-background/98 p-3">
              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/80 bg-background p-3 shadow-xl">
                <div className="mb-1 text-xs font-semibold">Whiteboard</div>
                {viewer}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function WhiteboardToolbar({
  expanded,
  zoom,
  onExpand,
  onReset,
  onZoomIn,
  onZoomOut,
}: {
  expanded: boolean;
  zoom: number;
  onExpand: () => void;
  onReset: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}) {
  const buttonClass = "size-7 rounded-sm";

  return (
    <div
      className="mb-1 flex h-7 shrink-0 items-center justify-end gap-0.5"
      role="toolbar"
      aria-label="Whiteboard view controls"
    >
      <span className="mr-1 min-w-9 text-right font-mono text-[10px] text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={buttonClass}
        title="Zoom out"
        aria-label="Zoom out"
        disabled={zoom <= WHITEBOARD_VIEWPORT_MIN_ZOOM}
        onClick={onZoomOut}
      >
        <MinusIcon />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={buttonClass}
        title="Reset whiteboard view"
        aria-label="Reset whiteboard view"
        disabled={zoom === WHITEBOARD_VIEWPORT_MIN_ZOOM}
        onClick={onReset}
      >
        <RotateCcwIcon />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={buttonClass}
        title="Zoom in"
        aria-label="Zoom in"
        disabled={zoom >= WHITEBOARD_VIEWPORT_MAX_ZOOM}
        onClick={onZoomIn}
      >
        <PlusIcon />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={buttonClass}
        title={expanded ? "Close expanded whiteboard" : "Expand whiteboard"}
        aria-label={
          expanded ? "Close expanded whiteboard" : "Expand whiteboard"
        }
        onClick={onExpand}
      >
        {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
      </Button>
    </div>
  );
}
