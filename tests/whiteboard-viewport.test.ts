import assert from "node:assert/strict";
import test from "node:test";
import {
  WHITEBOARD_VIEWPORT_MAX_ZOOM,
  WHITEBOARD_VIEWPORT_MIN_ZOOM,
  clampWhiteboardViewportOffset,
  clampWhiteboardViewportZoom,
  hasMermaidWhiteboard,
} from "../src/lib/meeting/whiteboard-viewport.js";

test("clamps whiteboard zoom to the supported range", () => {
  assert.equal(clampWhiteboardViewportZoom(0.25), WHITEBOARD_VIEWPORT_MIN_ZOOM);
  assert.equal(clampWhiteboardViewportZoom(2.5), 2.5);
  assert.equal(clampWhiteboardViewportZoom(8), WHITEBOARD_VIEWPORT_MAX_ZOOM);
  assert.equal(
    clampWhiteboardViewportZoom(Number.NaN),
    WHITEBOARD_VIEWPORT_MIN_ZOOM
  );
});

test("clamps whiteboard panning to scaled content bounds", () => {
  assert.deepEqual(
    clampWhiteboardViewportOffset(
      { x: -2_000, y: -2_000 },
      {
        viewportWidth: 400,
        viewportHeight: 300,
        contentWidth: 800,
        contentHeight: 600,
        zoom: 2,
      }
    ),
    { x: -1_200, y: -900 }
  );

  assert.deepEqual(
    clampWhiteboardViewportOffset(
      { x: 120, y: 80 },
      {
        viewportWidth: 400,
        viewportHeight: 300,
        contentWidth: 800,
        contentHeight: 600,
        zoom: 2,
      }
    ),
    { x: 0, y: 0 }
  );
});

test("keeps whiteboard content anchored when it fits the viewport", () => {
  assert.deepEqual(
    clampWhiteboardViewportOffset(
      { x: -100, y: -50 },
      {
        viewportWidth: 900,
        viewportHeight: 500,
        contentWidth: 600,
        contentHeight: 300,
        zoom: 1,
      }
    ),
    { x: 0, y: 0 }
  );
});

test("detects Mermaid whiteboards without treating plain text as interactive", () => {
  assert.equal(
    hasMermaidWhiteboard("```mermaid\nflowchart LR\nA --> B\n```"),
    true
  );
  assert.equal(hasMermaidWhiteboard("```MMD\ngraph TD\nA --> B\n```"), true);
  assert.equal(hasMermaidWhiteboard("Client -> API -> Database"), false);
});
