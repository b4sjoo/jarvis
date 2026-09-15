import { GenerationResultLedger, type GenerationResultLease } from "../../src/lib/meeting/generation-result-ledger.js";
import { selectInterviewPlaybook } from "../../src/lib/meeting/interview-playbook.js";
import { parseMeetingAnswer } from "../../src/lib/meeting/meeting-answer.js";
import { buildMeetingAnswerDisplayModel } from "../../src/lib/meeting/meeting-answer-display.js";
import { buildBranchPhaseOutputNotice } from "../../src/lib/meeting/phase-output-presentation.js";
import { commitStableAnswerRevision, commitStableArtifactOnlyRevision, type StableArtifactOnlyCommitDecision } from "../../src/lib/meeting/stable-answer.js";
import type { GenerationCommitDisposition } from "../../src/lib/meeting/meeting-presentation-contracts.js";
import type { ActiveInterviewParent, AdvisorSuggestion, InterviewPlaybookPhase } from "../../src/lib/meeting/types.js";

export function createPhaseOutputUiFixture(input: {
  sourcePhase?: InterviewPlaybookPhase;
  status?: GenerationCommitDisposition;
  restartAfterCancellation?: boolean;
  repair?: "answer" | "artifacts";
  withRetainedCode?: boolean;
}) {
  const reference = {
    sessionId: "phase-ui-session", runtimeEpoch: 4, taskId: "phase-ui-parent",
    logicalQuestionUnitId: "phase-ui-question", logicalQuestionRevision: 3,
    questionSourceHash: "phase-ui-source-hash", settlementId: "phase-ui-settlement",
    sourceTraceId: "phase-ui-source-trace", sourceSuggestionId: "phase-ui-old-suggestion",
    sourceTurnIds: ["phase-ui-turn"], sourceObservationIds: ["phase-ui-screen"],
    owner: { kind: "parent-mainline" as const, parentId: "phase-ui-parent" },
    committedAt: 100, generationLeaseId: "phase-ui-generation",
  };
  const phase = "implementation_validation";
  const playbook = selectInterviewPlaybook({ query: "Implement LRU cache", questionType: "coding" });
  if (!playbook) throw new Error("Coding fixture playbook missing");
  const parent: ActiveInterviewParent = {
    id: reference.taskId, source: "voice", stableKind: "coding", topic: "Implement LRU cache",
    playbook: { ...playbook, phase }, playbookPhase: phase, phaseProgress: {}, revisions: 2,
    createdAt: 1, updatedAt: 110, supportedFactAnchors: [],
    originQuestionId: reference.logicalQuestionUnitId,
    sourceQuestionUnitId: reference.logicalQuestionUnitId, sourceQuestionRevision: reference.logicalQuestionRevision,
    settlementId: reference.settlementId, canonicalQuestionSourceTurnIds: reference.sourceTurnIds,
    latestScreenObservationId: reference.sourceObservationIds[0],
  };
  const answer = "Answer: Retained LRU explanation.\nComplexity: O(1).";
  const fullContent = answer + "\nCode:\n```python\ndef get(key):\n    return cache[key]\n```";
  const content = input.sourcePhase === "optimized_pseudocode" && !input.withRetainedCode ? answer : fullContent;
  const candidate: AdvisorSuggestion = {
    id: reference.sourceSuggestionId, sourceTraceId: reference.sourceTraceId,
    kind: "answer", content, meetingAnswer: parseMeetingAnswer(content), generationPhase: input.sourcePhase,
    taskId: reference.taskId, parentTaskId: reference.taskId, taskSource: "voice", questionType: "coding",
    createdAt: 90, basedOnTurnIds: reference.sourceTurnIds, basedOnObservationIds: reference.sourceObservationIds,
    confidence: "high", questionLineage: {
      questionInstanceId: reference.logicalQuestionUnitId, questionOriginTraceId: reference.sourceTraceId,
      triggerTurnId: reference.sourceTurnIds[0], sourceSuggestionId: reference.sourceSuggestionId,
      sessionId: reference.sessionId, runtimeEpoch: reference.runtimeEpoch, identityState: "canonical",
    },
  };
  const publication = {
    ...reference, sectionOwner: reference.owner,
    settlementSnapshot: { id: reference.settlementId, logicalQuestionUnitId: reference.logicalQuestionUnitId, logicalQuestionRevision: reference.logicalQuestionRevision },
  };
  let stable = commitStableAnswerRevision({ ...publication, candidate, authorizedArtifacts: ["answer", "code", "complexity"] });
  if (!stable) throw new Error("Stable fixture publication failed");
  const previousStable = stable;
  let artifactCommit: StableArtifactOnlyCommitDecision | undefined;
  if (input.repair) {
    const repairCandidate: AdvisorSuggestion = { ...candidate, id: "phase-ui-repair", content: fullContent, meetingAnswer: parseMeetingAnswer(fullContent), generationPhase: phase };
    if (input.repair === "artifacts") {
      artifactCommit = commitStableArtifactOnlyRevision({
        current: stable, candidate: repairCandidate, authorizedArtifacts: ["code", "complexity"],
        expectedVisibleAnswerRevision: stable.revision, expectedTaskId: reference.taskId,
        expectedLogicalQuestionUnitId: reference.logicalQuestionUnitId,
        expectedLogicalQuestionRevision: reference.logicalQuestionRevision,
        expectedSettlementId: reference.settlementId, sectionOwner: reference.owner, committedAt: 200,
      });
      stable = artifactCommit.stable ?? stable;
    } else {
      stable = commitStableAnswerRevision({
        ...publication, current: stable, candidate: repairCandidate, authorizedArtifacts: ["answer"], committedAt: 200,
      });
    }
    if (!stable) throw new Error("Stable fixture repair failed");
  }
  const lease: GenerationResultLease = {
    id: reference.generationLeaseId, sessionId: reference.sessionId, runtimeEpoch: reference.runtimeEpoch,
    taskId: reference.taskId, logicalQuestionUnitId: reference.logicalQuestionUnitId,
    logicalQuestionRevision: reference.logicalQuestionRevision, modelRoute: "fixture-no-provider", startedAt: 120,
  };
  const ledger = new GenerationResultLedger();
  if (input.status || input.restartAfterCancellation) {
    ledger.begin({ lease, phaseContext: { owner: reference.owner, phase }, traceId: "phase-ui-generation-trace", now: 120 });
    if (input.status) ledger.recordCommitDisposition({ lease, disposition: input.status, reason: "fixture-outcome", now: 130 });
    if (input.restartAfterCancellation) {
      ledger.begin({ lease: { ...lease, id: "phase-ui-newer-generation", startedAt: 140 }, phaseContext: { owner: reference.owner, phase }, traceId: "phase-ui-newer-trace", now: 140 });
      ledger.terminalize({ generationLeaseId: lease.id, disposition: "cancelled", reason: "late-old-cancellation", source: "fixture", authority: "fixture", now: 150 });
    }
  }
  const generation = ledger.latestPhaseResult({ sessionId: reference.sessionId, runtimeEpoch: reference.runtimeEpoch, parentId: parent.id, childId: parent.child?.id });
  const notice = buildBranchPhaseOutputNotice({ parent, stable, generation });
  return {
    reference, parent, stable, previousStable, artifactCommit, generation, generations: ledger.listEntries(), notice,
    sections: buildMeetingAnswerDisplayModel({ content: stable.suggestion.content, parsedAnswer: stable.suggestion.meetingAnswer }),
  };
}
