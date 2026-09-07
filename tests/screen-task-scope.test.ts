import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyAdvisorScreenScopeToPromptContext,
  decideAdvisorScreenScope,
  decideScreenResultScope,
  formatAdvisorScreenSourceReadForTrace,
  resolveAdvisorScreenSourceRead,
  resolveAdvisorRequestModeForScreenScope,
  resolveAdvisorTaskEvidenceSource,
  decideManualScreenVoiceQuestionBinding,
  decideManualScreenContinuityEvidence,
  commitManualScreenQuestionPacket,
  resolveManualScreenSourcePacket,
  resolveManualScreenTranscriptContext,
  formatManualScreenVoiceQuestionBindingForTrace,
  formatManualScreenSourcePacketForTrace,
  selectManualScreenVoiceQuestionCapsule,
} from "../src/lib/meeting/screen-task-scope.js";
import { buildManualScreenLogicalQuestionUnit } from "../src/lib/meeting/manual-screen-question-source.js";
import {
  createProvisionalCurrentQuestion,
  resolveSettlementOwnedQuestionSource,
  settleCurrentQuestion,
  validateCurrentQuestionSettlementIdentity,
} from "../src/lib/meeting/current-question-settlement.js";
import {
  authorizeRuntimeTypeAdjudicationOutputAuthority,
  createRuntimeTypeAdjudicationOutputAuthority,
} from "../src/lib/meeting/answer-generation-lease.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
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
    sourceScreenSelectionSource: "active-branch",
    sourceVoiceTurnIds: ["turn-58-63"],
    sourceReadDisposition: "attached",
    sourceScreenImageAttached: true,
  });
});

test("keeps Voice settlement authority while reading an active-branch Screen", () => {
  const logicalQuestionUnit: LogicalQuestionUnit = {
    id: "voice-over-screen-lqu",
    revision: 1,
    sessionId: "session-1",
    runtimeEpoch: 4,
    currentTurnId: "turn-highlight",
    sourceTurnIds: ["turn-highlight"],
    sources: [
      {
        turnId: "turn-highlight",
        text: "What does the currently highlighted code do?",
        startedAt: 1,
        endedAt: 2,
      },
    ],
    normalizedText: "What does the currently highlighted code do?",
    startedAt: 1,
    updatedAt: 2,
    compositionReasons: ["no-previous-logical-question"],
    boundaryReason: "no-previous-logical-question",
    truncated: false,
  };
  const committedQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    sourceKind: "voice",
  });
  const settlement = settleCurrentQuestion({
    currentQuestion: committedQuestion,
    llmProposal: {
      source: "runtime-adjudication",
      sessionId: "session-1",
      runtimeEpoch: 4,
      logicalQuestionUnitId: logicalQuestionUnit.id,
      revision: logicalQuestionUnit.revision,
      sourceHash: committedQuestion.sourceHash,
      questionType: "coding",
      relation: "followup-parent",
      action: "answer",
      evidenceMode: "factual-explanation",
      confidence: 0.95,
      typeEvidenceAuthorized: true,
      relationEvidenceAuthorized: true,
      actionEvidenceAuthorized: true,
      expectedParentId: "parent-1",
      expectedParentRevision: 2,
      reasons: ["runtime-type-and-relation"],
    },
    activeParentId: "parent-1",
    activeParentRevision: 2,
    manualCorrectionRevision: 0,
    policy: {
      allowRuntimeTypeAdjudication: true,
      allowLlmRelationRepair: true,
      allowLlmActionRepair: true,
      runtimeMutationAuthorized: true,
      questionComplete: true,
      commitParent: false,
    },
  });
  const consumerSource = resolveSettlementOwnedQuestionSource({
    settlement,
    fallbackSourceKind: "mixed",
    fallbackSourceObservationIds: ["screen-a"],
  });
  const consumerQuestion = createProvisionalCurrentQuestion({
    logicalQuestionUnit,
    ...consumerSource,
  });
  const authority = createRuntimeTypeAdjudicationOutputAuthority({
    operationId: "voice-over-screen-operation",
    settlement,
    manualCorrectionRevision: 0,
  });

  assert.deepEqual(
    validateCurrentQuestionSettlementIdentity({
      settlement,
      currentQuestion: consumerQuestion,
    }),
    { authorized: true, reasons: [] }
  );
  assert.ok(authority);
  assert.deepEqual(
    authorizeRuntimeTypeAdjudicationOutputAuthority(authority, {
      settlementId: settlement.settlementId,
      sessionId: "session-1",
      runtimeEpoch: 4,
      logicalQuestionUnitId: logicalQuestionUnit.id,
      logicalQuestionRevision: logicalQuestionUnit.revision,
      manualCorrectionRevision: 0,
    }),
    { authorized: true, reason: "authorized" }
  );

  const screenRead = resolveAdvisorScreenSourceRead({
    mode: "screen-anchored",
    expectedSessionId: "session-1",
    currentSessionId: "session-1",
    expectedRuntimeEpoch: 4,
    currentRuntimeEpoch: 4,
    expectedParentId: "parent-1",
    activeMeetingTask: {
      parent: { id: "parent-1" },
      screen: { observationId: "screen-a" },
    },
    screenObservations: [
      {
        id: "screen-a",
        capturedAt: 1,
        source: "hotkey",
        imageBase64: "screen-image",
        changed: true,
      },
    ],
    preferredObservationIds: settlement.sourceObservationIds,
    sourceVoiceTurnIds: logicalQuestionUnit.sourceTurnIds,
    providerSupportsImages: true,
  });
  assert.equal(consumerQuestion.sourceKind, "voice");
  assert.deepEqual(consumerQuestion.sourceObservationIds, []);
  assert.equal(screenRead.disposition, "attached");
  assert.equal(screenRead.selectionSource, "active-branch");
  assert.equal(screenRead.sourceScreenObservationId, "screen-a");
});

test("prefers an exact settlement observation over the active branch screen", () => {
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
        topic: "Explain the highlighted lines",
        playbookPhase: "implementation_validation",
        phaseProgress: {},
        supportedFactAnchors: [],
        createdAt: 1,
        updatedAt: 1,
      },
      screen: {
        activeScreenTaskId: "canonical-screen:branch-screen",
        observationId: "branch-screen",
        basedOnObservationId: "branch-screen",
      },
    },
    screenObservations: [
      {
        id: "recovery-screen",
        capturedAt: 1,
        source: "hotkey",
        imageBase64: "recovery-image",
        changed: true,
      },
      {
        id: "branch-screen",
        capturedAt: 2,
        source: "hotkey",
        imageBase64: "branch-image",
        changed: true,
      },
    ],
    preferredObservationIds: ["recovery-screen"],
    providerSupportsImages: true,
  });

  assert.equal(decision.disposition, "attached");
  assert.equal(decision.sourceScreenObservationId, "recovery-screen");
  assert.equal(decision.selectionSource, "settlement");
  assert.equal(decision.image?.base64, "recovery-image");
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

test("does not substitute an active-branch image for an explicit visible-source action", () => {
  const decision = resolveAdvisorScreenSourceRead({
    mode: "screen-anchored",
    expectedSessionId: "session-1",
    currentSessionId: "session-1",
    expectedRuntimeEpoch: 4,
    currentRuntimeEpoch: 4,
    expectedParentId: "parent-1",
    activeMeetingTask: {
      parent: { id: "parent-1" },
      screen: { observationId: "observation-new" },
    },
    screenObservations: [
      {
        id: "observation-new",
        capturedAt: 1,
        source: "hotkey",
        imageBase64: "new-image",
        changed: true,
      },
    ],
    preferredObservationIds: ["observation-original"],
    requirePreferredObservation: true,
    providerSupportsImages: true,
  });

  assert.equal(decision.disposition, "preferred-observation-unavailable");
  assert.equal(decision.selectionSource, "settlement");
  assert.equal(decision.image, undefined);
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

test("binds a Voice LQU as the primary ask and keeps Screen as visual evidence", () => {
  const packet = resolveManualScreenSourcePacket({
    voiceQuestion: {
      logicalQuestionUnitId: "question-current",
      logicalQuestionRevision: 2,
      text: "Explain lines 35 through 38.",
      sourceTurnIds: ["turn-35"],
    },
    screenObservationId: "screen-1",
    screenPreflightQuestion: "Implement the LRU cache.",
    focusedEvidenceSummary:
      "Cursor is on line 35; lines 35 through 38 show the eviction branch.",
  });

  assert.deepEqual(packet.primaryAsk, {
    text: "Explain lines 35 through 38.",
    source: "voice-lqu",
    sourceTurnIds: ["turn-35"],
    logicalQuestionUnitId: "question-current",
    revision: 2,
    screenObservationId: "screen-1",
  });
  assert.equal(packet.visualEvidence.preflightQuestion, "Implement the LRU cache.");
  assert.equal(
    packet.visualEvidence.focusedEvidenceSummary,
    "Cursor is on line 35; lines 35 through 38 show the eviction branch."
  );
  assert.equal(packet.sourceOperationAuthority.boundVoicePrimaryAsk, true);
  assert.deepEqual(
    formatManualScreenSourcePacketForTrace(packet),
    {
      manualScreenPrimaryAskSource: "voice-lqu",
      manualScreenPrimaryAskChars: 28,
      manualScreenPrimaryAskSourceTurnIds: ["turn-35"],
      manualScreenPrimaryAskLogicalQuestionUnitId: "question-current",
      manualScreenPrimaryAskLogicalQuestionRevision: 2,
      manualScreenPrimaryAskSourceHash: undefined,
      manualScreenVisualEvidenceObservationId: "screen-1",
      manualScreenVisualEvidenceQuestionChars: 24,
      manualScreenFocusedEvidenceChars: 67,
      manualScreenSourceOperationAuthority: "manual-screen",
      manualScreenExplicitCapture: true,
      manualScreenBoundVoicePrimaryAsk: true,
      manualScreenQuestionPacketCommitted: false,
      manualScreenQuestionPacketSessionId: undefined,
      manualScreenQuestionPacketRuntimeEpoch: undefined,
      manualScreenQuestionPacketLogicalQuestionUnitId: undefined,
      manualScreenQuestionPacketLogicalQuestionRevision: undefined,
      manualScreenQuestionPacketSourceHash: undefined,
    }
  );
});

test("commits one immutable identity for Screen recovery consumers", () => {
  const candidate = resolveManualScreenSourcePacket({
    voiceQuestion: {
      logicalQuestionUnitId: "question-current",
      logicalQuestionRevision: 2,
      text: "Explain lines 35 through 38.",
      sourceTurnIds: ["turn-35"],
    },
    screenObservationId: "screen-1",
    screenPreflightQuestion: "Implement the LRU cache.",
  });
  const packet = commitManualScreenQuestionPacket({
    packet: candidate,
    sessionId: "session-1",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "question-current",
    revision: 2,
    sourceHash: "source-hash-1",
  });

  assert.equal(packet.primaryAsk.text, "Explain lines 35 through 38.");
  assert.equal(packet.primaryAsk.sourceHash, "source-hash-1");
  assert.equal(
    packet.visualEvidence.preflightQuestion,
    "Implement the LRU cache."
  );
  assert.deepEqual(packet.questionIdentity, {
    sessionId: "session-1",
    runtimeEpoch: 3,
    logicalQuestionUnitId: "question-current",
    revision: 2,
    sourceHash: "source-hash-1",
  });
  assert.equal(
    formatManualScreenSourcePacketForTrace(packet)
      .manualScreenQuestionPacketCommitted,
    true
  );
});

test("binds the exact active or pending Voice attempt to manual Screen evidence", () => {
  const candidate = {
    logicalQuestionUnitId: "question-current",
    logicalQuestionRevision: 2,
    text: "Explain lines 35 through 38.",
    sourceTurnIds: ["turn-35"],
  };

  assert.equal(
    decideManualScreenVoiceQuestionBinding({
      candidate,
      activeVoiceAttempt: {
        logicalQuestionUnitId: "question-current",
        logicalQuestionRevision: 2,
      },
    }).reason,
    "active-voice-attempt"
  );
  assert.equal(
    decideManualScreenVoiceQuestionBinding({
      candidate,
      pendingVoiceDelivery: {
        logicalQuestionUnitId: "question-current",
        logicalQuestionRevision: 2,
      },
    }).disposition,
    "bind-voice"
  );
});

test("does not let a local sufficiency observation bind a committed Voice answer", () => {
  const candidate = {
    logicalQuestionUnitId: "question-current",
    logicalQuestionRevision: 2,
    text: "Explain lines 35 through 38.",
    sourceTurnIds: ["turn-35"],
  };
  const decision = decideManualScreenVoiceQuestionBinding({
    candidate,
    visibleAnswer: {
      logicalQuestionUnitId: "question-current",
      logicalQuestionRevision: 2,
    },
  });

  assert.equal(decision.disposition, "use-screen");
  assert.equal(decision.reason, "visible-answer-already-committed");
});

test("gives exact visual recovery continuity authority", () => {
  const candidate = {
    logicalQuestionUnitId: "question-current",
    logicalQuestionRevision: 2,
    text: "Explain lines 35 through 38.",
    sourceTurnIds: ["turn-35"],
  };
  const binding = decideManualScreenVoiceQuestionBinding({
    candidate,
    awaitingVisualEvidenceTarget: {
      logicalQuestionUnitId: "question-current",
      logicalQuestionRevision: 2,
    },
  });
  const continuity = decideManualScreenContinuityEvidence({
    exactVisualEvidenceRecovery: true,
    projectAnchorMatches: false,
    correctionTermOverlap: 0,
  });

  assert.equal(binding.disposition, "bind-voice");
  assert.equal(binding.reason, "awaiting-visual-evidence-recovery");
  assert.deepEqual(continuity, {
    relation: "followup-parent",
    reason: "screen-exact-visual-evidence-recovery",
    confidence: 1,
    relationEvidenceAuthorized: true,
  });
});

test("wires only the task-bound visual recovery fact into Screen binding", () => {
  const hook = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
  const capture = hook.slice(
    hook.indexOf("  const captureScreenContext = useCallback"),
    hook.indexOf("  const correctActiveQuestionType = useCallback")
  );

  assert.equal(
    capture.match(
      /awaitingVisualEvidenceTarget: selectedVisualRecovery\.fact/g
    )?.length,
    2
  );
  assert.doesNotMatch(capture, /unresolvedManualCorrectionTarget/);
  assert.doesNotMatch(capture, /explicitRecoveryTarget:/);
  assert.match(
    capture,
    /screenVoiceQuestionBinding\.disposition === "bind-voice"[\s\S]{0,300}applyBoundVisualRecovery\(/
  );
  assert.match(
    capture,
    /effectiveDecision === "bind-voice"[\s\S]{0,300}applyBoundVisualRecovery\(/
  );
});

test("keeps project and correction continuity matches non-authoritative", () => {
  const project = decideManualScreenContinuityEvidence({
    exactVisualEvidenceRecovery: false,
    projectAnchorMatches: true,
    correctionTermOverlap: 0,
  });
  const correction = decideManualScreenContinuityEvidence({
    exactVisualEvidenceRecovery: false,
    projectAnchorMatches: false,
    correctionTermOverlap: 1,
  });

  assert.equal(project?.relation, "unknown");
  assert.equal(project?.proposedRelation, "resume-parent");
  assert.equal(project?.relationEvidenceAuthorized, false);
  assert.equal(correction?.relation, "unknown");
  assert.equal(correction?.proposedRelation, "resume-parent");
  assert.equal(correction?.relationEvidenceAuthorized, false);
});

test("releases an answered Voice LQU before an unrelated Screen question", () => {
  const candidate = {
    logicalQuestionUnitId: "behavioral-question",
    logicalQuestionRevision: 1,
    text: "Tell me about a time you disagreed with a teammate.",
    sourceTurnIds: ["turn-behavioral"],
  };
  const decision = decideManualScreenVoiceQuestionBinding({
    candidate,
    visibleAnswer: {
      logicalQuestionUnitId: "behavioral-question",
      logicalQuestionRevision: 1,
    },
  });

  assert.equal(decision.disposition, "use-screen");
  assert.equal(decision.reason, "visible-answer-already-committed");
  assert.deepEqual(formatManualScreenVoiceQuestionBindingForTrace(decision), {
    manualScreenVoiceCandidateLogicalQuestionUnitId: "behavioral-question",
    manualScreenVoiceCandidateLogicalQuestionRevision: 1,
    manualScreenVoiceCandidateSourceTurnIds: ["turn-behavioral"],
    manualScreenVoiceCandidateChars: 51,
    manualScreenVoiceBindingDisposition: "use-screen",
    manualScreenVoiceBindingReason: "visible-answer-already-committed",
    manualScreenFinalQuestionOwner: "screen-preflight",
  });
});

test("does not bind an idle Voice candidate without recovery authority", () => {
  const decision = decideManualScreenVoiceQuestionBinding({
    candidate: {
      logicalQuestionUnitId: "question-idle",
      logicalQuestionRevision: 1,
      text: "Old unresolved question.",
      sourceTurnIds: ["turn-old"],
    },
  });

  assert.equal(decision.disposition, "use-screen");
  assert.equal(decision.reason, "voice-recovery-not-authorized");
});

test("uses Screen preflight as the primary ask when no Voice question is bound", () => {
  const packet = resolveManualScreenSourcePacket({
    screenObservationId: "screen-2",
    screenPreflightQuestion: "Design a URL shortener.",
  });

  assert.deepEqual(packet.primaryAsk, {
    text: "Design a URL shortener.",
    source: "screen-preflight",
    sourceTurnIds: [],
    screenObservationId: "screen-2",
  });
  assert.equal(packet.sourceOperationAuthority.boundVoicePrimaryAsk, false);
  assert.equal(resolveManualScreenTranscriptContext(packet), "");
});

test("keeps the bound Voice LQU identity while Screen supplies visual evidence", () => {
  const packet = resolveManualScreenSourcePacket({
    voiceQuestion: {
      logicalQuestionUnitId: "question-current",
      logicalQuestionRevision: 2,
      text: "Explain lines 35 through 38.",
      sourceTurnIds: ["turn-35"],
    },
    screenObservationId: "screen-voice-recovery",
    screenPreflightQuestion: "Implement the LRU cache.",
  });
  const unit = buildManualScreenLogicalQuestionUnit({
    packet,
    sessionId: "session-1",
    runtimeEpoch: 3,
    createdAt: 100,
    transcriptTurns: [
      {
        id: "turn-35",
        speaker: "them",
        text: "Explain lines 35 through 38.",
        startedAt: 80,
        endedAt: 90,
        isFinal: true,
        source: "system-audio",
      },
    ],
  });

  assert.ok(unit);
  assert.equal(unit.id, "question-current");
  assert.equal(unit.revision, 2);
  assert.equal(unit.normalizedText, "Explain lines 35 through 38.");
  assert.deepEqual(unit.sourceTurnIds, ["turn-35"]);
  assert.equal(unit.sources[0]?.startedAt, 80);
  assert.equal(unit.boundaryReason, "manual-screen-visual-evidence");
  assert.equal(
    resolveManualScreenTranscriptContext(packet),
    "Them: Explain lines 35 through 38."
  );
});

test("gives a Screen-owned milestone its own canonical question identity", () => {
  const packet = resolveManualScreenSourcePacket({
    screenObservationId: "screen-new-question",
    screenPreflightQuestion: "Tell me about a time you disagreed.",
  });
  const unit = buildManualScreenLogicalQuestionUnit({
    packet,
    sessionId: "session-1",
    runtimeEpoch: 3,
    createdAt: 100,
  });

  assert.ok(unit);
  assert.equal(
    unit.id,
    "screen-answer-sufficiency:screen-new-question"
  );
  assert.equal(unit.revision, 1);
  assert.deepEqual(unit.sourceTurnIds, []);
  assert.equal(unit.currentTurnId, "screen:screen-new-question");
  assert.equal(unit.boundaryReason, "visible-screen-question");
});
