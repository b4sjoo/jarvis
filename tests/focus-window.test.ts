import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createMeetingFocusDisplayModel, readMeetingFocusDisplay } from "../src/lib/meeting/focus-display.js";
import {
  EMPTY_MEETING_FOCUS_SNAPSHOT,
  resolveFocusControlsGeometry,
} from "../src/lib/meeting/focus-window.js";

test("phase output notice crosses Focus as optional plain display text only", () => {
  const phaseOutputNotice = "Implementation validation: Code not ready for this phase.";
  const display = createMeetingFocusDisplayModel({ ...EMPTY_MEETING_FOCUS_SNAPSHOT, phaseOutputNotice });
  assert.equal(readMeetingFocusDisplay(JSON.parse(JSON.stringify(display))).phaseOutputNotice, phaseOutputNotice);
  assert.equal(createMeetingFocusDisplayModel(EMPTY_MEETING_FOCUS_SNAPSHOT).phaseOutputNotice, undefined);
  assert.throws(() => readMeetingFocusDisplay({ ...EMPTY_MEETING_FOCUS_SNAPSHOT, phaseOutputNotice: { phase: "implementation_validation" } }), /Invalid Focus text field/);
});

test("Normal and inline/native Focus read the shared notice only in answer areas", () => {
  const normal = readFileSync("src/pages/app/components/meeting/index.tsx", "utf8");
  const native = readFileSync("src/pages/app/components/meeting/focus-window.tsx", "utf8");
  assert.match(normal, /phaseOutputNotice: adviseDisplay\.locked \? undefined : meeting\.phaseOutputNotice/);
  const ast = ts.createSourceFile("meeting.tsx", normal, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let notice: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "phaseOutputNotice" &&
        node.initializer.getText(ast).includes("meeting.phaseOutputNotice")) notice = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(notice);
  for (const locked of [false, true]) {
    const selected = vm.runInNewContext(ts.transpileModule(`(${notice.getText(ast)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText, { adviseDisplay: { locked }, meeting: { phaseOutputNotice: "Current phase output pending" } });
    assert.equal(selected, locked ? undefined : "Current phase output pending");
  }
  assert.match(normal, /phaseOutputNotice=\{focusSnapshot\.phaseOutputNotice\}/);
  assert.equal((normal.match(/<PhaseOutputNotice notice=\{focusSnapshot\.phaseOutputNotice\}/g) ?? []).length, 2);
  assert.match(normal, /<PhaseOutputNotice notice=\{phaseOutputNotice\}/);
  const controlsStart = native.indexOf("function MeetingFocusControlsWindow");
  assert.match(native.slice(0, controlsStart), /<PhaseOutputNotice notice=\{snapshot\.phaseOutputNotice\}/);
  assert.doesNotMatch(native.slice(controlsStart), /PhaseOutputNotice/);
});


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
      preferredHeight: 280,
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
  assert.ok(decision.preferredHeight > 280);
  assert.equal(decision.transcriptScrollRequired, false);
});

test("focus controls cap very long transcripts and require local scrolling", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 500,
  });

  assert.equal(decision.preferredWidth, 1_280);
  assert.equal(decision.preferredHeight, 440);
  assert.equal(decision.transcriptScrollRequired, true);
});

test("focus controls reserve correction history without shrinking transcript", () => {
  const decision = resolveFocusControlsGeometry({
    measuredTranscriptHeight: 500,
    reservedAuxiliaryHeight: 24,
  });

  assert.equal(decision.preferredWidth, 1_280);
  assert.equal(decision.preferredHeight, 440);
  assert.equal(decision.reservedAuxiliaryHeight, 24);
  assert.equal(decision.transcriptScrollRequired, true);
});
