import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAnswerGenerationLease,
  createAnswerGenerationLease,
  decideRefreshAuthority,
} from "../src/lib/meeting/answer-generation-lease.js";
import { projectActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { decideAdvisorTurnIntent } from "../src/lib/meeting/advisor-turn-intent.js";
import { compileSettledAdvisorPromptContext } from "../src/lib/meeting/settled-advisor-context.js";
import { composeExpandedAdvisorPromptContext } from "../src/lib/meeting/context-scope-response-action.js";
import { composeCanonicalTurnCandidate } from "../src/lib/meeting/logical-question-unit.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import { buildQuestionTypeAdjudicationRequest } from "../src/lib/meeting/question-type-adjudication.js";
import {
  appendSourceOwnedSetupCandidate,
  createSourceOwnedSetupCandidate,
  selectSourceOwnedSemanticContext,
} from "../src/lib/meeting/source-owned-semantic-context.js";
import {
  createSourceOwnedTransitionCandidate,
  prepareSourceOwnedTransition,
} from "../src/lib/meeting/source-owned-transition-transaction.js";
import { buildTaskRelationAdjudicationRequest } from "../src/lib/meeting/task-relation-adjudication.js";
import { decideOrderedTaskRelationResolution } from "../src/lib/meeting/task-relation-split-shadow.js";
import type {
  ActiveInterviewParent,
  AdvisorPromptContext,
  MeetingContextState,
  TranscriptTurn,
} from "../src/lib/meeting/types.js";
import { recentSourceContextRuntimeScenarios as scenarios } from "./fixtures/recent-source-context-runtime-scenarios.js";

test("same-type substantive turns keep independent LQU identity inside 45 seconds", () => {
  const first = composeCanonicalTurnCandidate({
    currentTurn: turn(scenarios.sameTypeIndependent.first),
    sessionId: "session-context",
    runtimeEpoch: 3,
  });
  const second = composeCanonicalTurnCandidate({
    currentTurn: turn(scenarios.sameTypeIndependent.second),
    sessionId: "session-context",
    runtimeEpoch: 3,
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
  assert.deepEqual(second.sourceTurnIds, ["turn-second-design"]);
});

test("36-second AI/ML to Coding scenario keeps context but attaches a Coding child", () => {
  const parentTurn = turn(scenarios.aiMlToCodingChild.parent);
  const setupTurn = turn(scenarios.aiMlToCodingChild.setup);
  const askTurn = turn(scenarios.aiMlToCodingChild.ask);
  const parent = activeParent(parentTurn);
  const activeBefore = projectActiveMeetingTask({
    state: { revision: 1, parent },
  });
  assert.ok(activeBefore);

  const setupCandidate = createSourceOwnedSetupCandidate({
    turn: setupTurn,
    sessionId: "session-context",
    runtimeEpoch: 3,
    activeMeetingTask: activeBefore,
  });
  assert.ok(setupCandidate);
  const candidate = composeCanonicalTurnCandidate({
    currentTurn: askTurn,
    sessionId: "session-context",
    runtimeEpoch: 3,
  });
  const contextSelection = selectSourceOwnedSemanticContext({
    candidate: setupCandidate,
    sessionId: "session-context",
    runtimeEpoch: 3,
    logicalQuestionUnit: candidate,
    activeMeetingTask: activeBefore,
    transcriptTurns: [parentTurn, setupTurn, askTurn],
  });
  assert.ok(contextSelection.context);
  const current = {
    ...candidate,
    contextSourceTurnIds: [...contextSelection.context.sourceTurnIds],
  };

  const typeRequest = buildQuestionTypeAdjudicationRequest({
    logicalQuestionUnit: current,
  });
  assert.deepEqual(typeRequest.question.sourceTurnIds, [askTurn.id]);
  assert.doesNotMatch(typeRequest.question.text, /access control/i);

  const relationRequest = buildTaskRelationAdjudicationRequest({
    logicalQuestionUnit: current,
    activeMeetingTask: activeBefore,
    recentTurns: [parentTurn, setupTurn, askTurn],
    recentSourceContext: contextSelection.context,
  });
  assert.match(
    relationRequest.recentSourceEvidence.map((item) => item.text).join(" "),
    /access control/i
  );
  const relation = decideOrderedTaskRelationResolution({
    sourceKind: "voice",
    currentQuestionType: "coding",
    activeParentQuestionType: "ai-ml-system-design",
    hasActiveChild: false,
    parentAffinity: {
      schemaVersion: 1,
      affinityKind: "parent",
      decision: "related",
      confidence: 0.98,
      currentEvidenceSpans: ["Within this RAG system"],
      branchEvidenceSpans: ["enterprise RAG system"],
    },
    finalizeWithNullHypothesis: true,
  });
  assert.equal(relation.status, "resolved");
  assert.equal(relation.relation, "child-probe");
  assert.equal(relation.stage, "runtime-matrix");

  const transitionCandidate = createSourceOwnedTransitionCandidate({
    sessionId: "session-context",
    runtimeEpoch: 3,
    source: "voice",
    sourceTurnIds: current.sourceTurnIds,
    logicalQuestionUnitId: current.id,
    logicalQuestionRevision: current.revision,
    existingTask: parent,
    relation: relation.relation!,
    authoritySource: "committed-settlement",
    mutationAuthorized: true,
    questionType: "coding",
    question: current.normalizedText,
    playbook: selectInterviewPlaybook({
      query: current.normalizedText,
      questionType: "coding",
      classifierConfidence: 0.98,
    }),
  });
  assert.ok(transitionCandidate);
  const transition = prepareSourceOwnedTransition({
    candidate: transitionCandidate,
    currentTask: parent,
    currentSessionId: "session-context",
    currentRuntimeEpoch: 3,
  });
  assert.equal(transition.reason, "child-probe-committed");
  assert.equal(transition.task?.child?.questionType, "coding");
  assert.equal(
    transition.task?.child?.phaseState?.phase,
    "implementation_validation"
  );

  const activeAfter = projectActiveMeetingTask({
    state: { revision: 2, parent: transition.task },
  });
  assert.ok(activeAfter);
  const compilation = compileSettledAdvisorPromptContext({
    baseContext: promptContext(activeAfter, [parentTurn, setupTurn, askTurn]),
    contextReadScope: "active-child-read",
    logicalQuestionUnit: current,
    transcriptTurns: [parentTurn, setupTurn, askTurn],
    recentSourceContext: contextSelection.context,
  });
  assert.deepEqual(compilation.selectedSourceTurnIds, [
    parentTurn.id,
    setupTurn.id,
    askTurn.id,
  ]);
  assert.equal(compilation.context.activeMeetingTask?.child?.questionType, "coding");
});

test("an Open Source Context Group can span 150 seconds through rolling gaps", () => {
  const sourceTurns = scenarios.longOpenSourceGroup.map(turn);
  let group = sourceTurns
    .map((sourceTurn) =>
      createSourceOwnedSetupCandidate({
        turn: sourceTurn,
        sessionId: "session-long",
        runtimeEpoch: 1,
      })
    )
    .reduce((current, next) => {
      assert.ok(next);
      return appendSourceOwnedSetupCandidate(current, next);
    }, undefined as ReturnType<typeof createSourceOwnedSetupCandidate>);
  assert.ok(group);
  assert.ok(group.endedAt - group.startedAt > 45_000);

  const askTurn = turn(scenarios.terminalAsk);
  const ask = composeCanonicalTurnCandidate({
    currentTurn: askTurn,
    sessionId: "session-long",
    runtimeEpoch: 1,
  });
  const selection = selectSourceOwnedSemanticContext({
    candidate: group,
    sessionId: "session-long",
    runtimeEpoch: 1,
    logicalQuestionUnit: ask,
    transcriptTurns: [...sourceTurns, askTurn],
  });

  assert.deepEqual(selection.context?.sourceTurnIds, sourceTurns.map((item) => item.id));
  assert.equal(selection.reason, "selected-recent-source-context");
});

test("orphan context expires after 45 seconds while task-owned context persists", () => {
  const setupTurn = turn(scenarios.expiredSetup);
  const askTurn = turn(scenarios.expiredAsk);
  const setup = createSourceOwnedSetupCandidate({
    turn: setupTurn,
    sessionId: "session-expired",
    runtimeEpoch: 1,
  });
  assert.ok(setup);
  const ask = composeCanonicalTurnCandidate({
    currentTurn: askTurn,
    sessionId: "session-expired",
    runtimeEpoch: 1,
  });
  const selection = selectSourceOwnedSemanticContext({
    candidate: setup,
    sessionId: "session-expired",
    runtimeEpoch: 1,
    logicalQuestionUnit: ask,
    transcriptTurns: [setupTurn, askTurn],
  });
  assert.equal(selection.reason, "candidate-expired");
  assert.equal(selection.context, undefined);

  const parent = activeParent(setupTurn);
  const active = projectActiveMeetingTask({ state: { revision: 1, parent } });
  assert.ok(active);
  const compiled = compileSettledAdvisorPromptContext({
    baseContext: promptContext(active, [setupTurn, askTurn]),
    contextReadScope: "active-parent-read",
    logicalQuestionUnit: ask,
    transcriptTurns: [setupTurn, askTurn],
  });
  assert.match(compiled.context.transcript, /private customer documents/i);
});

test("filler preserves the active lease and a later substantive LQU wins publication", () => {
  const firstTurn = turn(scenarios.sameTypeIndependent.first);
  const first = composeCanonicalTurnCandidate({
    currentTurn: firstTurn,
    sessionId: "session-latest",
    runtimeEpoch: 1,
  });
  const lease = createAnswerGenerationLease({
    sessionId: "session-latest",
    runtimeEpoch: 1,
    preparationContextRevision: 0,
    taskId: "parent-1",
    taskRevision: 1,
    logicalQuestionUnitId: first.id,
    logicalQuestionRevision: first.revision,
    baseVisibleAnswerRevision: 0,
    sourceTurnIds: first.sourceTurnIds,
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    modelRoute: "main:test",
    artifactOwnerId: "parent-1",
    requestedArtifacts: ["answer"],
  });
  const fillerIntent = decideAdvisorTurnIntent(scenarios.filler.text, {
    hasActiveTask: true,
    hasRecentQuestionContext: true,
  });
  const fillerRefresh = decideRefreshAuthority({
    source: "live-turn",
    turnIntentDecision: fillerIntent,
  });
  assert.equal(fillerRefresh.authorized, false);
  assert.equal(
    authorizeAnswerGenerationLease(lease, leaseSnapshot(first.id)).authorized,
    true
  );

  const second = composeCanonicalTurnCandidate({
    currentTurn: turn(scenarios.sameTypeIndependent.second),
    sessionId: "session-latest",
    runtimeEpoch: 1,
  });
  const stale = authorizeAnswerGenerationLease(lease, leaseSnapshot(second.id));
  assert.equal(stale.authorized, false);
  assert.equal(stale.reason, "logical-question-mismatch");
});

test("explicit Enhance can read source evidence older than the automatic window", () => {
  const parentTurn = turn({
    id: "turn-old-parent",
    text: "The ranking service combines lexical and vector retrieval.",
    startedAt: 1_000,
    endedAt: 2_000,
  });
  const currentTurn = turn({
    id: "turn-enhance",
    text: "How would that affect retrieval quality?",
    startedAt: 70_000,
    endedAt: 71_000,
  });
  const parent = activeParent(parentTurn);
  const active = projectActiveMeetingTask({ state: { revision: 1, parent } });
  assert.ok(active);
  const current = composeCanonicalTurnCandidate({
    currentTurn,
    sessionId: "session-enhance",
    runtimeEpoch: 1,
  });
  const meetingContext: MeetingContextState = {
    sessionId: "session-enhance",
    startedAt: 0,
    transcriptTurns: [parentTurn, currentTurn],
    screenObservations: [],
    taskRuntime: { revision: 1, parent },
    activeMeetingTask: active,
    rollingSummary: "",
    userProfileContext: "",
    glossary: [],
  };
  const result = composeExpandedAdvisorPromptContext({
    baseContext: promptContext(active, [parentTurn, currentTurn]),
    logicalQuestionUnit: current,
    meetingContext,
    activeMeetingTask: active,
    questionRelation: "referential-follow-up",
  });

  assert.ok(result.selectedTurnIds.includes(parentTurn.id));
  assert.match(result.promptContext.transcript, /lexical and vector retrieval/i);
});

function activeParent(source: TranscriptTurn): ActiveInterviewParent {
  return {
    id: "parent-rag",
    source: "voice",
    stableKind: "ai-ml-system-design",
    topic: source.text,
    playbookPhase: "requirement_clarification",
    phaseProgress: {},
    supportedFactAnchors: [],
    createdAt: source.startedAt,
    updatedAt: source.endedAt,
    startTurnId: source.id,
    promptTranscriptStartTurnId: source.id,
    canonicalQuestionSourceTurnIds: [source.id],
    revisions: 1,
  };
}

function promptContext(
  activeMeetingTask: NonNullable<ReturnType<typeof projectActiveMeetingTask>>,
  turns: TranscriptTurn[]
): AdvisorPromptContext {
  const current = turns.at(-1)!;
  return {
    transcript: turns.map((item) => `Them: ${item.text}`).join("\n"),
    advisorPromptSourceTurnIds: turns.map((item) => item.id),
    screenContext: "",
    taskRuntime: { revision: activeMeetingTask.runtimeRevision },
    activeMeetingTask,
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    latestTurn: current,
    currentQuestionProjection: {
      answerFocusText: current.text,
      semanticEvidenceText: current.text,
      sourceTurnIds: [current.id],
    },
  };
}

function leaseSnapshot(logicalQuestionUnitId: string) {
  return {
    sessionId: "session-latest",
    runtimeEpoch: 1,
    preparationContextRevision: 0,
    taskId: "parent-1",
    taskRevision: 1,
    logicalQuestionUnitId,
    logicalQuestionRevision: 1,
    visibleAnswerRevision: 0,
    manualCorrectionRevision: 0,
    responseActionRevision: 0,
    artifactOwnerId: "parent-1",
    authorizedArtifacts: ["answer" as const],
  };
}

function turn(input: {
  id: string;
  text: string;
  startedAt: number;
  endedAt: number;
}): TranscriptTurn {
  return {
    ...input,
    speaker: "them",
    source: "system-audio",
    isFinal: true,
  };
}
