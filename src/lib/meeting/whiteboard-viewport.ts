export const WHITEBOARD_VIEWPORT_MIN_ZOOM = 1;
export const WHITEBOARD_VIEWPORT_MAX_ZOOM = 4;
export const WHITEBOARD_VIEWPORT_ZOOM_STEP = 0.5;

export interface WhiteboardViewportOffset {
  x: number;
  y: number;
}

export interface WhiteboardViewportBounds {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
  zoom: number;
}

export function clampWhiteboardViewportZoom(value: number) {
  if (!Number.isFinite(value)) return WHITEBOARD_VIEWPORT_MIN_ZOOM;
  return Math.min(
    WHITEBOARD_VIEWPORT_MAX_ZOOM,
    Math.max(WHITEBOARD_VIEWPORT_MIN_ZOOM, value)
  );
}

export function clampWhiteboardViewportOffset(
  offset: WhiteboardViewportOffset,
  bounds: WhiteboardViewportBounds
): WhiteboardViewportOffset {
  const zoom = clampWhiteboardViewportZoom(bounds.zoom);
  const viewportWidth = toNonNegative(bounds.viewportWidth);
  const viewportHeight = toNonNegative(bounds.viewportHeight);
  const contentWidth = toNonNegative(bounds.contentWidth) * zoom;
  const contentHeight = toNonNegative(bounds.contentHeight) * zoom;
  const minimumX = Math.min(0, viewportWidth - contentWidth);
  const minimumY = Math.min(0, viewportHeight - contentHeight);

  return {
    x: clampFinite(offset.x, minimumX, 0),
    y: clampFinite(offset.y, minimumY, 0),
  };
}

export function hasMermaidWhiteboard(value: string) {
  return /```(?:mermaid|mmd)\b/i.test(value);
}

function clampFinite(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(minimum, value));
}

function toNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
