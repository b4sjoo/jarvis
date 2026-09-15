import assert from "node:assert/strict";
import test from "node:test";
import { buildBranchPhaseOutputNotice } from "../src/lib/meeting/phase-output-presentation.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import {
  collectStableAnswerMutatedArtifacts,
  commitStableAnswerRevision,
  commitStableArtifactOnlyRevision,
  type StableAnswerRevision,
} from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { ActiveInterviewParent, AdvisorSuggestion, InterviewPlaybookPhase } from "../src/lib/meeting/types.js";
import { createPhaseOutputUiFixture } from "./helpers/phase-output-ui-fixture.js";

const owner = { kind: "parent-mainline" as const, parentId: "parent" };
const priorContent = "Answer: Use a map and linked list.\nComplexity: O(1).";
const completeContent = `${priorContent}\nCode:\n\`\`\`python\ndef get(key):\n    return cache[key]\n\`\`\``;

function parent(phase: InterviewPlaybookPhase = "implementation_validation"): ActiveInterviewParent {
  const playbook = selectInterviewPlaybook({ query: "Implement LRU cache", questionType: "coding" });
  assert.ok(playbook);
  return {
    id: "parent", source: "voice", stableKind: "coding", topic: "Implement LRU cache",
    playbook: { ...playbook, phase }, playbookPhase: phase, phaseProgress: {},
    supportedFactAnchors: [], createdAt: 1, updatedAt: 1, revisions: 2,
  };
}

function suggestion(id: string, content: string, generationPhase?: InterviewPlaybookPhase): AdvisorSuggestion {
  return {
    id, content, generationPhase, meetingAnswer: parseMeetingAnswer(content),
    kind: "answer", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [], confidence: "high",
  };
}

function publish(generationPhase?: InterviewPlaybookPhase, content = priorContent): StableAnswerRevision {
  const stable = commitStableAnswerRevision({
    candidate: suggestion("prior", content, generationPhase),
    authorizedArtifacts: ["answer", "code", "complexity"], sectionOwner: owner,
    taskId: "parent", logicalQuestionUnitId: "question", logicalQuestionRevision: 1,
    sessionId: "session", runtimeEpoch: 1, committedAt: 1,
  });
  assert.ok(stable);
  return stable;
}

test("MR5 aligned output has no notice, even if an unrelated later error exists", () => {
  assert.equal(buildBranchPhaseOutputNotice({
    parent: parent("optimized_pseudocode"), stable: publish("optimized_pseudocode"),
    generation: { owner, phase: "optimized_pseudocode", status: "failed" },
  }), undefined);
});

test("MR5 phase advance and matching generation states retain old output without task mutation", () => {
  const active = parent();
  const stable = publish("optimized_pseudocode");
  const before = structuredClone({ active, stable });
  for (const [status, text] of [
    ["started", "Generating."], ["pending", "awaiting publication"],
    ["failed", "Generation failed."], ["timed-out", "Generation failed."],
    ["cancelled", "Generation cancelled."], ["aborted", "Generation cancelled."],
    ["superseded", "Generation cancelled."],
  ] as const) {
    const notice = buildBranchPhaseOutputNotice({
      parent: active, stable, generation: { owner, phase: "implementation_validation", status },
    });
    assert.ok(notice);
    assert.ok(notice.includes(text));
    assert.match(notice, /Implementation validation: Answer, Code, Complexity not ready/);
    assert.match(notice, /Previously published content remains available/);
  }
  const restarted = buildBranchPhaseOutputNotice({
    parent: active, stable, generation: { owner, phase: "implementation_validation", status: "started" },
  });
  assert.doesNotMatch(restarted!, /failed|cancelled/);
  assert.deepEqual({ active, stable }, before);
});

test("MR6 Answer-only recovery leaves missing Implementation Code and retained Complexity unready", () => {
  const current = publish("optimized_pseudocode");
  const stable = commitStableAnswerRevision({
    current, candidate: suggestion("answer-repair", "Answer: Here is the implementation explanation.", "implementation_validation"),
    authorizedArtifacts: ["answer"], taskId: "parent", sectionOwner: owner,
    logicalQuestionUnitId: "question", logicalQuestionRevision: 1,
  });
  assert.ok(stable);
  assert.equal(stable.sections.answer.phase, "implementation_validation");
  assert.deepEqual(stable.sections.complexity, current.sections.complexity);
  assert.deepEqual(stable.sections.code, current.sections.code);
  assert.match(buildBranchPhaseOutputNotice({ parent: parent(), stable })!, /Code, Complexity not ready/);

  const repaired = commitStableArtifactOnlyRevision({
    current: stable, candidate: suggestion("artifact-repair", completeContent, "implementation_validation"),
    authorizedArtifacts: ["code", "complexity"], sectionOwner: owner,
    expectedVisibleAnswerRevision: stable.revision, expectedTaskId: "parent",
    expectedLogicalQuestionUnitId: "question", expectedLogicalQuestionRevision: 1,
  });
  assert.equal(repaired.disposition, "committed");
  assert.ok(repaired.stable);
  assert.deepEqual(repaired.stable.sections.answer, stable.sections.answer);
  assert.equal(repaired.stable.suggestion.meetingAnswer?.sections.answer, stable.suggestion.meetingAnswer?.sections.answer);
  assert.equal(repaired.stable.sections.complexity.revision, stable.sections.complexity.revision);
  assert.equal(repaired.stable.sections.complexity.phase, "implementation_validation");
  assert.equal(buildBranchPhaseOutputNotice({ parent: parent(), stable: repaired.stable }), undefined);
});

test("MR6 Artifact-only repair leaves the earlier Answer phase readable and unready", () => {
  const current = publish("optimized_pseudocode");
  const decision = commitStableArtifactOnlyRevision({
    current, candidate: suggestion("artifacts", completeContent, "implementation_validation"),
    authorizedArtifacts: ["code", "complexity"], sectionOwner: owner,
    expectedVisibleAnswerRevision: current.revision, expectedTaskId: "parent",
    expectedLogicalQuestionUnitId: "question", expectedLogicalQuestionRevision: 1,
  });
  assert.equal(decision.disposition, "committed");
  assert.ok(decision.stable);
  assert.deepEqual(decision.stable.sections.answer, current.sections.answer);
  assert.match(buildBranchPhaseOutputNotice({ parent: parent(), stable: decision.stable })!, /Answer not ready/);
});

test("same-content publication refreshes phase provenance without content revisions or mutations", () => {
  const current = publish("optimized_pseudocode", completeContent);
  const stable = commitStableAnswerRevision({
    current, candidate: suggestion("same-content", completeContent, "implementation_validation"),
    authorizedArtifacts: ["answer", "code", "complexity"], sectionOwner: owner,
    taskId: "parent", logicalQuestionUnitId: "question", logicalQuestionRevision: 1, committedAt: 2,
  });
  assert.ok(stable);
  for (const section of ["answer", "code", "complexity"] as const) {
    assert.equal(stable.sections[section].phase, "implementation_validation");
    assert.equal(stable.sections[section].revision, current.sections[section].revision);
    assert.equal(stable.sections[section].sourceSuggestionId, "same-content");
    assert.equal(stable.sections[section].updatedAt, 2);
    assert.deepEqual(stable.sections[section].owner, current.sections[section].owner);
  }
  assert.deepEqual(collectStableAnswerMutatedArtifacts(current, stable), []);
  assert.equal(buildBranchPhaseOutputNotice({ parent: parent(), stable }), undefined);
});

test("same-content Artifact-only publication accepts a phase provenance repair", () => {
  const current = publish("optimized_pseudocode", completeContent);
  const decision = commitStableArtifactOnlyRevision({
    current, candidate: suggestion("same-artifacts", completeContent, "implementation_validation"),
    authorizedArtifacts: ["code", "complexity"], sectionOwner: owner,
    expectedVisibleAnswerRevision: current.revision, expectedTaskId: "parent",
    expectedLogicalQuestionUnitId: "question", expectedLogicalQuestionRevision: 1,
  });
  assert.equal(decision.disposition, "committed");
  assert.deepEqual(decision.mutatedArtifacts, []);
  assert.deepEqual(decision.stable?.sections.answer, current.sections.answer);
  assert.equal(decision.stable?.sections.code.revision, current.sections.code.revision);
  assert.equal(decision.stable?.sections.code.phase, "implementation_validation");
});

test("authorized but omitted sections retain their original phase and content", () => {
  const current = publish("optimized_pseudocode", completeContent);
  const stable = commitStableAnswerRevision({
    current, candidate: suggestion("omitted-artifacts", "Answer: Updated explanation.", "implementation_validation"),
    authorizedArtifacts: ["answer", "code", "complexity"], sectionOwner: owner,
    taskId: "parent", logicalQuestionUnitId: "question", logicalQuestionRevision: 1,
  });
  assert.ok(stable);
  for (const section of ["code", "complexity"] as const) {
    assert.deepEqual(stable.sections[section], current.sections[section]);
    assert.equal(stable.suggestion.meetingAnswer?.sections[section], current.suggestion.meetingAnswer?.sections[section]);
  }
  assert.match(buildBranchPhaseOutputNotice({ parent: parent(), stable })!, /Code, Complexity not ready/);
});

test("system-design readiness requires its Whiteboard while preserving the prior diagram", () => {
  const active = parent("design_framing");
  active.stableKind = "general-system-design";
  active.playbook = selectInterviewPlaybook({ query: "Design a backend", questionType: "general-system-design" });
  const stable = commitStableAnswerRevision({
    candidate: suggestion("design", "Answer: Start with one region.\nWhiteboard:\n```mermaid\ngraph TD\nA-->B\n```", "requirement_clarification"),
    authorizedArtifacts: ["answer", "whiteboard"], taskId: "parent", sectionOwner: owner,
    logicalQuestionUnitId: "design", logicalQuestionRevision: 1,
  });
  assert.ok(stable);
  const before = structuredClone(stable);
  assert.match(buildBranchPhaseOutputNotice({ parent: active, stable })!, /Answer, Whiteboard not ready/);
  assert.deepEqual(stable, before);
  assert.equal(stable.sections.whiteboard.phase, "requirement_clarification");
});

test("MR5 owner switches and unavailable child phase never project the departed branch notice", () => {
  const stable = publish("optimized_pseudocode");
  const generation = { owner, phase: "implementation_validation" as const, status: "failed" as const };
  assert.equal(buildBranchPhaseOutputNotice({ parent: { ...parent(), id: "other-parent" }, stable, generation }), undefined);
  const active = parent();
  active.child = {
    id: "child", questionType: "coding", intent: "implementation-probe", relation: "child-probe",
    question: "Child implementation", createdAt: 2, updatedAt: 2, basedOnTurnIds: [], basedOnObservationIds: [],
    phaseState: { playbook: active.playbook!, phase: "implementation_validation", phaseProgress: {}, revision: 1 },
  };
  assert.equal(buildBranchPhaseOutputNotice({ parent: active, stable, generation }), undefined);
  const childOwner = { kind: "active-child" as const, parentId: "parent", childId: "child" };
  const childStable = commitStableAnswerRevision({
    current: stable, candidate: suggestion("child-answer", "Answer: Child plan.", "optimized_pseudocode"),
    authorizedArtifacts: ["answer"], taskId: "parent", sectionOwner: childOwner,
    logicalQuestionUnitId: "child-question", logicalQuestionRevision: 1,
  });
  assert.ok(childStable);
  const notice = buildBranchPhaseOutputNotice({ parent: active, stable: childStable, generation });
  assert.match(notice!, /not ready/);
  assert.doesNotMatch(notice!, /failed/);
  assert.match(buildBranchPhaseOutputNotice({ parent: active, stable: childStable, generation: { ...generation, owner: childOwner } })!, /Generation failed/);
  delete active.child.phaseState;
  assert.equal(buildBranchPhaseOutputNotice({ parent: active, stable: childStable, generation }), undefined);
});

test("legacy unstamped output and unknown or mismatched generation state use neutral readiness", () => {
  const stable = publish(undefined, completeContent);
  assert.equal(stable.sections.answer.phase, undefined);
  for (const generation of [undefined, { owner, phase: "optimized_pseudocode" as const, status: "failed" as const }]) {
    const notice = buildBranchPhaseOutputNotice({ parent: parent(), stable, generation });
    assert.match(notice!, /Source phase is unknown for Answer, Code, Complexity/);
    assert.doesNotMatch(notice!, /not ready|Generating|failed|cancelled|awaiting publication/);
  }
  assert.equal(buildBranchPhaseOutputNotice({ parent: parent() }), undefined);
  assert.equal(buildBranchPhaseOutputNotice({ stable }), undefined);
});

test("legacy provenance uncertainty is disclosed separately from an actually missing section", () => {
  const stable = publish(undefined);
  const before = structuredClone(stable);
  const notice = buildBranchPhaseOutputNotice({ parent: parent(), stable });
  assert.match(notice!, /Code not ready for this phase/);
  assert.match(notice!, /Source phase is unknown for Answer, Complexity/);
  assert.deepEqual(stable, before);
});

test("metadata-only artifact phase revalidation preserves full source references and Answer provenance", () => {
  const { reference, previousStable, stable, artifactCommit, notice } = createPhaseOutputUiFixture({
    sourcePhase: "optimized_pseudocode", withRetainedCode: true, repair: "artifacts",
  });
  assert.equal(artifactCommit?.disposition, "committed");
  assert.deepEqual(artifactCommit.mutatedArtifacts, []);
  for (const key of ["sessionId", "runtimeEpoch", "taskId", "logicalQuestionUnitId", "logicalQuestionRevision", "questionSourceHash", "settlementId"] as const) {
    assert.equal(stable[key], reference[key]);
    assert.equal(stable[key], previousStable[key]);
  }
  assert.deepEqual(stable.settlementSnapshot, previousStable.settlementSnapshot);
  assert.deepEqual(stable.suggestion.questionLineage, previousStable.suggestion.questionLineage);
  assert.deepEqual(stable.suggestion.basedOnTurnIds, reference.sourceTurnIds);
  assert.deepEqual(stable.suggestion.basedOnObservationIds, reference.sourceObservationIds);
  assert.equal(stable.suggestion.sourceTraceId, reference.sourceTraceId);
  assert.deepEqual(stable.sections.answer, previousStable.sections.answer);
  for (const section of ["code", "complexity"] as const) {
    assert.equal(stable.suggestion.meetingAnswer?.sections[section], previousStable.suggestion.meetingAnswer?.sections[section]);
    assert.deepEqual(stable.sections[section], {
      revision: previousStable.sections[section].revision, owner: reference.owner,
      phase: "implementation_validation", sourceSuggestionId: "phase-ui-repair", updatedAt: 200,
    });
  }
  assert.match(notice!, /Answer not ready/);
  assert.doesNotMatch(notice!, /Code|Complexity/);
});

test("same-phase same-content artifact result retains the original no-change rejection and metadata", () => {
  const { previousStable, stable, artifactCommit, notice } = createPhaseOutputUiFixture({
    sourcePhase: "implementation_validation", repair: "artifacts",
  });
  assert.equal(artifactCommit?.disposition, "rejected");
  assert.equal(artifactCommit.reason, "artifact-candidate-no-change");
  assert.deepEqual(artifactCommit.mutatedArtifacts, []);
  assert.deepEqual(stable, previousStable);
  assert.equal(notice, undefined);
});
