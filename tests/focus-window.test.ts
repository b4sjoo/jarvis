import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EMPTY_MEETING_FOCUS_SNAPSHOT,
  resolveFocusControlsGeometry,
} from "../src/lib/meeting/focus-window.js";


test("focus snapshot excludes historical transcripts", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      EMPTY_MEETING_FOCUS_SNAPSHOT,
      "transcriptHistory"
    ),
    false
  );
});

test("focus snapshot keeps current-question and durable-parent types separate", () => {
  assert.equal(EMPTY_MEETING_FOCUS_SNAPSHOT.effectiveQuestionType, undefined);
  assert.equal(EMPTY_MEETING_FOCUS_SNAPSHOT.parentQuestionType, undefined);
  assert.equal(EMPTY_MEETING_FOCUS_SNAPSHOT.parentTaskId, undefined);
  assert.equal(EMPTY_MEETING_FOCUS_SNAPSHOT.durableOwnerMissing, false);
});

test("renders the existing Approach snapshot in both Focus answer surfaces", () => {
  const protectedWindow = readFileSync(
    "src/pages/app/components/meeting/focus-window.tsx",
    "utf8"
  );
  const embeddedFallback = readFileSync(
    "src/pages/app/components/meeting/index.tsx",
    "utf8"
  );
  const protectedAnswer = protectedWindow.slice(
    protectedWindow.indexOf("function MeetingFocusAnswerWindow"),
    protectedWindow.indexOf("function MeetingFocusControlsWindow")
  );
  const embeddedAnswer = embeddedFallback.slice(
    embeddedFallback.indexOf("const FocusModePanel"),
    embeddedFallback.indexOf("const TranscriptLineageWindow")
  );

  assert.match(protectedAnswer, /Approach[\s\S]*sections\.approach/);
  assert.match(
    embeddedAnswer,
    /Approach[\s\S]*suggestionSections\.approach/
  );
});

test("focus controls keep short transcripts at the compact base geometry", () => {
  assert.deepEqual(
    resolveFocusControlsGeometry({
      measuredTranscriptHeight: 60,
    }),
    {
      preferredWidth: 920,
      preferredHeight: 230,
      measuredTranscriptHeight: 60,
      estimatedTranscriptHeight: 60,
      reservedAuxiliaryHeight: 0,
      transcriptScrollRequired: false,
    }
  );
});

test("focus controls expand width before consuming vertical space", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 120,
  });

  assert.equal(decision.preferredWidth, 1_080);
  assert.ok(decision.preferredHeight > 230);
  assert.equal(decision.transcriptScrollRequired, false);
});

test("focus controls cap very long transcripts and require local scrolling", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 500,
  });

  assert.equal(decision.preferredWidth, 1_280);
  assert.equal(decision.preferredHeight, 410);
  assert.equal(decision.transcriptScrollRequired, true);
});

test("focus controls reserve correction history without shrinking transcript", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 500,
    reservedAuxiliaryHeight: 24,
  });

  assert.equal(decision.preferredWidth, 1_280);
  assert.equal(decision.preferredHeight, 434);
  assert.equal(decision.reservedAuxiliaryHeight, 24);
  assert.equal(decision.transcriptScrollRequired, true);
});
