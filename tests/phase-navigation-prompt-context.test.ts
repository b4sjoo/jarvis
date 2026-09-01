import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composePhaseNavigationPromptContext } from "../src/lib/meeting/phase-navigation-prompt-context.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/types.js";

test("phase navigation keeps procedural authority while bounding broad history", () => {
  const repeatedHistory = "OLD_HISTORY ".repeat(1_500);
  const context: AdvisorPromptContext = {
    transcript: repeatedHistory,
    screenContext: repeatedHistory,
    currentQuestionProjection: {
      answerFocusText: "Design a URL shortener.",
      semanticEvidenceText: "Design a URL shortener with high availability.",
      sourceTurnIds: ["turn-current"],
    },
    taskRuntime: { revision: 9 },
    activeMeetingTask: {
      id: "parent-1",
      runtimeRevision: 9,
      source: "voice",
      parent: {
        id: "parent-1",
        questionType: "general-system-design",
        topic: "URL shortener",
        playbookPhase: "design_framing",
        phaseProgress: { requirement_clarification: true },
        supportedFactAnchors: ["fact-1"],
        latestUsefulAnswer: repeatedHistory,
        previousUsefulAnswer: repeatedHistory,
        whiteboardArtifact: {
          id: "whiteboard-1",
          parentTaskId: "parent-1",
          domainTrack: "general_sd",
          archetypeIds: [],
          selectedOverlayIds: [],
          currentPhase: "design_framing",
          title: "URL shortener",
          content: repeatedHistory,
          summary: "Client to API gateway to write service and cache.",
          revision: 2,
          updateSource: "manual-next",
          updatedAt: 100,
          createdAt: 50,
        },
        createdAt: 10,
        updatedAt: 100,
        revisions: 4,
      },
    },
    rollingSummary: repeatedHistory,
    userProfileContext: repeatedHistory,
    glossaryText: repeatedHistory,
    memoryContext: `HIGH_VALUE_MEMORY\n${"MEMORY ".repeat(2_000)}`,
  };
  const previousSuggestion = [
    "Answer:",
    "We should start with a write path and a redirect path.",
    "Approach:",
    "APPROACH ".repeat(500),
    "Whiteboard:",
    "graph TD\nA --> B\n".repeat(500),
  ].join("\n");

  const result = composePhaseNavigationPromptContext({
    action: "next-phase",
    promptContext: context,
    currentSuggestion: previousSuggestion,
  });

  assert.equal(result.promptContext.activeMeetingTask?.id, "parent-1");
  assert.equal(
    result.promptContext.activeMeetingTask?.parent.playbookPhase,
    "design_framing"
  );
  assert.equal(result.promptContext.transcript, "Them: Design a URL shortener.");
  assert.equal(result.promptContext.rollingSummary, "");
  assert.equal(result.promptContext.userProfileContext, "");
  assert.doesNotMatch(result.promptContext.transcript, /OLD_HISTORY/);
  assert.match(result.promptContext.memoryContext ?? "", /HIGH_VALUE_MEMORY/);
  assert.ok((result.promptContext.memoryContext?.length ?? 0) <= 6_000);
  assert.match(result.currentSuggestion ?? "", /Answer:/);
  assert.match(result.currentSuggestion ?? "", /Whiteboard:/);
  assert.ok((result.currentSuggestion?.length ?? 0) < previousSuggestion.length);
  assert.equal(result.metrics.compactionApplied, true);
  assert.ok(result.metrics.reductionChars > 10_000);
  assert.ok(result.metrics.reductionRatio > 0.5);
});

test("previous phase navigation does not manufacture a previous suggestion", () => {
  const context: AdvisorPromptContext = {
    transcript: "Them: Explain the architecture.",
    screenContext: "",
    taskRuntime: { revision: 1 },
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
  };

  const result = composePhaseNavigationPromptContext({
    action: "previous-phase",
    promptContext: context,
  });

  assert.equal(result.currentSuggestion, undefined);
  assert.match(result.promptContext.transcript, /Explain the architecture/);
});

test("first-time phase navigation shares one trace with its manual action", () => {
  const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const genericAction = source.slice(
    source.indexOf("const genericActionTrace"),
    source.indexOf("const answerClarifyingQuestion")
  );
  assert.match(genericAction, /stage: "accepted",\s*traceId: genericActionTrace\.id/);
  assert.match(genericAction, /runAdvisor\(\{[\s\S]*traceId: genericActionTrace\.id/);
  assert.match(genericAction, /stage: "terminal",\s*traceId: genericActionTrace\.id/);
  assert.match(
    genericAction,
    /logicalQuestionUnit: responseActionLogicalQuestionUnit/
  );
});
