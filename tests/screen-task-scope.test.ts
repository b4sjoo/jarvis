import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAdvisorScreenScopeToPromptContext,
  decideAdvisorScreenScope,
  decideScreenResultScope,
  formatAdvisorScreenSourceReadForTrace,
  resolveAdvisorScreenSourceRead,
  resolveAdvisorRequestModeForScreenScope,
  resolveAdvisorTaskEvidenceSource,
  selectManualScreenVoiceQuestionCapsule,
} from "../src/lib/meeting/screen-task-scope.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type {
  ActiveInterviewParent,
  ActiveScreenTask,
} from "../src/lib/meeting/types.js";
import { setTestTaskRuntime } from "./helpers/meeting-task-runtime.js";

test("clears an existing screen scope when a live voice turn opens a new parent", () => {
  const decision = decideAdvisorScreenScope({
    triggerSource: "live-turn",
    relation: "new-parent",
    hasActiveScreenTask: true,
  });

  assert.deepEqual(decision, {
    action: "clear",
    durability: "none",
    mutationAuthorized: true,
    reason: "voice-new-parent",
  });
});

test("keeps screen scope for child, resume, follow-up, and explicit actions", () => {
  for (const relation of [
    "child-probe",
    "resume-parent",
    "followup-parent",
  ] as const) {
    assert.equal(
      decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation,
        hasActiveScreenTask: true,
      }).action,
      "keep"
    );
  }

  assert.equal(
    decideAdvisorScreenScope({
      triggerSource: "response-action",
      relation: "new-parent",
      hasActiveScreenTask: true,
    }).reason,
    "explicit-action-preserve"
  );
});

test("removes task-owned context from a new voice parent prompt projection", () => {
  const manager = new MeetingContextManager();
  setTestTaskRuntime(manager, {
    screenAttachment: makeScreenTask(),
    parent: makeParent(),
  });
  const original = manager.buildAdvisorPromptContext();
  const projected = applyAdvisorScreenScopeToPromptContext(
    original,
    decideAdvisorScreenScope({
      triggerSource: "live-turn",
      relation: "new-parent",
      hasActiveScreenTask: true,
    })
  );

  assert.ok(original.activeMeetingTask);
  assert.equal(projected.screenContext, "");
  assert.equal(projected.taskRuntime.screenAttachment, undefined);
  assert.equal(projected.taskRuntime.parent, undefined);
  assert.equal(projected.activeMeetingTask, undefined);
  assert.equal(projected.interviewPlaybook, undefined);
  assert.equal(manager.getState().activeMeetingTask?.id, "parent-screen");
});

test("keeps unknown and ambiguous screen answers provisional", () => {
  for (const questionType of ["unknown", "ambiguous"] as const) {
    const decision = decideScreenResultScope({
      questionType,
      hasAnswer: true,
    });
    assert.equal(decision.action, "provisional");
    assert.equal(decision.durability, "provisional");
    assert.equal(decision.mutationAuthorized, false);
  }
});

test("allows only classified screen answers to replace durable task state", () => {
  assert.deepEqual(
    decideScreenResultScope({
      questionType: "general-system-design",
      hasAnswer: true,
    }),
    {
      action: "replace",
      durability: "durable",
      mutationAuthorized: true,
      reason: "screen-result-classified",
    }
  );
  assert.equal(
    decideScreenResultScope({
      questionType: "non-question",
      hasAnswer: true,
    }).action,
    "keep"
  );
  assert.equal(
    decideScreenResultScope({
      questionType: "coding",
      hasAnswer: false,
    }).action,
    "keep"
  );
});

test("treats live-turn evidence as voice even when a screen is active", () => {
  assert.equal(
    resolveAdvisorTaskEvidenceSource({
      triggerSource: "live-turn",
      hasActiveScreenTask: true,
    }),
    "voice"
  );
  assert.equal(
    resolveAdvisorTaskEvidenceSource({
      triggerSource: "response-action",
      hasActiveScreenTask: true,
    }),
    "screen"
  );
});

test("downgrades a cleared screen-anchored request to live mode", () => {
  const clearDecision = decideAdvisorScreenScope({
    triggerSource: "live-turn",
    relation: "new-parent",
    hasActiveScreenTask: true,
  });
  assert.equal(
    resolveAdvisorRequestModeForScreenScope(
      "screen-anchored",
      clearDecision
    ),
    "live"
  );
  assert.equal(
    resolveAdvisorRequestModeForScreenScope(
      "screen-anchored",
      decideAdvisorScreenScope({
        triggerSource: "live-turn",
        relation: "followup-parent",
        hasActiveScreenTask: true,
      })
    ),
    "screen-anchored"
  );
});

function makeParent(): ActiveInterviewParent {
  return {
    id: "parent-screen",
    source: "screen",
    stableKind: "general-system-design",
    topic: "Design a ticket service",
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    latestUsefulAnswer: "Clarify scale.",
    createdAt: 100,
    updatedAt: 110,
    revisions: 1,
  };
}

function makeScreenTask(): ActiveScreenTask {
  return {
    id: "screen-task-a",
    observationId: "screen-a",
    createdAt: 100,
    updatedAt: 110,
    question: "Design a ticket service",
    kind: "general-system-design",
    content: "Clarify scale.",
    basedOnTurnIds: [],
    basedOnObservationId: "screen-a",
  };
}

test("attaches only the full screenshot bound to the same parent and runtime", () => {
  const decision = resolveAdvisorScreenSourceRead({
    mode: "screen-anchored",
    expectedSessionId: "session-1",
    currentSessionId: "session-1",
    expectedRuntimeEpoch: 4,
    currentRuntimeEpoch: 4,
    expectedParentId: "parent-1",
    activeMeetingTask: {
      id: "task-1",
      runtimeRevision: 1,
      source: "screen",
      parent: {
        id: "parent-1",
        questionType: "coding",
        topic: "Explain lines 58 through 63",
        playbookPhase: "implementation_validation",
        phaseProgress: {},
        supportedFactAnchors: [],
        createdAt: 1,
        updatedAt: 1,
      },
      screen: {
        activeScreenTaskId: "screen-task-1",
        observationId: "observation-1",
        basedOnObservationId: "observation-1",
      },
    },
    screenObservations: [
      {
        id: "observation-1",
        capturedAt: 1,
        source: "hotkey",
        imageBase64: "full-image",
        imageMediaType: "image/png",
        focusImageBase64: "focus-image",
        changed: true,
      },
    ],
    sourceVoiceTurnIds: ["turn-58-63"],
    providerSupportsImages: true,
  });

  assert.equal(decision.disposition, "attached");
  assert.equal(decision.image?.base64, "full-image");
  assert.deepEqual(formatAdvisorScreenSourceReadForTrace(decision), {
    sourceScreenObservationId: "observation-1",
    sourceScreenParentId: "parent-1",
    sourceVoiceTurnIds: ["turn-58-63"],
    sourceReadDisposition: "attached",
    sourceScreenImageAttached: true,
  });
});

test("does not attach a screenshot across parent or runtime boundaries", () => {
  const base = {
    mode: "screen-anchored" as const,
    expectedSessionId: "session-1",
    currentSessionId: "session-1",
    expectedRuntimeEpoch: 4,
    currentRuntimeEpoch: 4,
    expectedParentId: "parent-2",
    activeMeetingTask: {
      id: "task-1",
      runtimeRevision: 1,
      source: "screen" as const,
      parent: {
        id: "parent-1",
        questionType: "coding" as const,
        topic: "LRU cache",
        playbookPhase: "implementation_validation" as const,
        phaseProgress: {},
        supportedFactAnchors: [],
        createdAt: 1,
        updatedAt: 1,
      },
      screen: {
        activeScreenTaskId: "screen-task-1",
        observationId: "observation-1",
        basedOnObservationId: "observation-1",
      },
    },
    screenObservations: [
      {
        id: "observation-1",
        capturedAt: 1,
        source: "hotkey" as const,
        imageBase64: "full-image",
        changed: true,
      },
    ],
    providerSupportsImages: true,
  };

  assert.equal(
    resolveAdvisorScreenSourceRead(base).disposition,
    "parent-mismatch"
  );
  assert.equal(
    resolveAdvisorScreenSourceRead({
      ...base,
      expectedParentId: "parent-1",
      currentRuntimeEpoch: 5,
    }).disposition,
    "runtime-epoch-mismatch"
  );
});

test("keeps only the current bounded voice question for manual screen recovery", () => {
  const capsule = selectManualScreenVoiceQuestionCapsule({
    sessionId: "session-1",
    runtimeEpoch: 3,
    candidates: [
      {
        id: "question-old-epoch",
        revision: 1,
        sessionId: "session-1",
        runtimeEpoch: 2,
        currentTurnId: "turn-old",
        sourceTurnIds: ["turn-old"],
        sources: [],
        normalizedText: "Old question",
        startedAt: 1,
        updatedAt: 1,
        compositionReasons: [],
        boundaryReason: "new-question",
        truncated: false,
      },
      {
        id: "question-current",
        revision: 2,
        sessionId: "session-1",
        runtimeEpoch: 3,
        currentTurnId: "turn-63",
        sourceTurnIds: ["turn-58", "turn-63"],
        sources: [],
        normalizedText: "Explain lines 58 through 63.",
        startedAt: 2,
        updatedAt: 3,
        compositionReasons: ["referential-completion"],
        boundaryReason: "extended",
        truncated: false,
      },
    ],
  });

  assert.deepEqual(capsule, {
    logicalQuestionUnitId: "question-current",
    logicalQuestionRevision: 2,
    text: "Explain lines 58 through 63.",
    sourceTurnIds: ["turn-58", "turn-63"],
  });
});
