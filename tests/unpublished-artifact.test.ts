import assert from "node:assert/strict";
import test from "node:test";
import { UnpublishedArtifactSlot, MAX_UNPUBLISHED_ARTIFACT_CHARS, type ArtifactReuseInputs } from "../src/lib/meeting/unpublished-artifact.js";
import { commitStableAnswerRevision, commitStableArtifactOnlyRevision } from "../src/lib/meeting/stable-answer.js";
import { parseMeetingAnswer } from "../src/lib/meeting/meeting-answer.js";
import type { ArtifactRegenerationTarget } from "../src/lib/meeting/artifact-regeneration.js";

const inputs = { manualCorrectionRevision: 0, preparationContextRevision: 1, settings: { useMemory: false } } as ArtifactReuseInputs;
const content = "Answer: Accepted answer.\n\nCode:\n```ts\nreturn 42;\n```\n\nComplexity: O(1)";
const parsed = parseMeetingAnswer(content);
function stable(id = "G1") {
  return commitStableAnswerRevision({ candidate: { id, content, meetingAnswer: parsed, sourceTraceId: id,
    kind: "answer", confidence: "high", createdAt: 1, basedOnTurnIds: [], basedOnObservationIds: [] },
    authorizedArtifacts: ["answer"], taskId: "parent", logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1,
    sessionId: "session", runtimeEpoch: 1, settlementId: "S1", questionSourceHash: "source" })!;
}
function target(answer = stable()): ArtifactRegenerationTarget {
  return { sessionId: "session", runtimeEpoch: 1, visibleAnswerRevision: answer.revision,
    logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1, settlementId: "S1", sourceHash: "source",
    parentId: "parent", parentRevision: 3, questionType: "coding", playbookPhase: "implementation_validation",
    phaseOwnerKind: "parent", phaseOwnerId: "parent", phaseOwnerRevision: 3,
    sectionOwner: { kind: "parent-mainline", parentId: "parent" }, artifactFamilies: ["code", "complexity"] };
}
function install(slot: UnpublishedArtifactSlot, answer = stable(), input = inputs, text = parsed, authorizedArtifacts = ["answer"]) {
  slot.accepted({ stable: answer, current: answer, target: target(answer), currentInputs: input,
    offer: { parsed: text, inputs: input, authorizedArtifacts } });
}

test("AR-C1 accepted unpublished pair uses artifact-only reducer and preserves Answer", () => {
  const slot = new UnpublishedArtifactSlot(), answer = stable(); install(slot, answer);
  const result = slot.take({ target: target(answer), stable: answer, inputs });
  assert.equal(result.reason, "matched"); assert.ok(result.candidate);
  const published = commitStableArtifactOnlyRevision({ current: answer,
    candidate: { ...answer.suggestion, id: "manual", content, meetingAnswer: parsed },
    authorizedArtifacts: ["code", "complexity"], expectedVisibleAnswerRevision: answer.revision,
    expectedTaskId: "parent", expectedLogicalQuestionUnitId: "lqu", expectedLogicalQuestionRevision: 1,
    expectedSettlementId: "S1", sectionOwner: target().sectionOwner });
  assert.equal(published.disposition, "committed");
  assert.equal(published.stable?.sections.answer.revision, answer.sections.answer.revision);
  assert.equal(slot.take({ target: target(answer), stable: answer, inputs }).reason, "candidate-missing");
});

test("AR-C2 exact generation, settlement, phase, source, revision, inputs and base required", () => {
  for (const change of ["generation", "settlementId", "parentRevision", "childId", "playbookPhase", "sourceHash", "base", "preparation", "correction", "settings"]) {
    const slot = new UnpublishedArtifactSlot(), answer = stable(); install(slot, answer);
    const request = { target: target(answer), stable: structuredClone(answer), inputs: structuredClone(inputs) };
    if (change === "generation") request.stable.suggestion.id = "G2";
    else if (change === "base") request.stable.sections.code.revision++;
    else if (change === "preparation") request.inputs.preparationContextRevision++;
    else if (change === "correction") request.inputs.manualCorrectionRevision++;
    else if (change === "settings") request.inputs.settings.useMemory = true;
    else Object.assign(request.target, { [change]: "changed" });
    assert.equal(slot.take(request).candidate, undefined, change);
  }
});

test("AR-C3/4 ineligible output clears slot, partial family and published output do not enter", () => {
  const slot = new UnpublishedArtifactSlot(), answer = stable();
  for (const text of ["Answer: only", "Answer: only\n\nCode:\n```ts\nreturn 1;\n```", `Answer: only\n\nCode: ${"x".repeat(MAX_UNPUBLISHED_ARTIFACT_CHARS)}\n\nComplexity: O(n)`]) {
    install(slot, answer); install(slot, stable("G2"), inputs, parseMeetingAnswer(text));
    assert.equal(slot.present, false);
  }
  install(slot, answer, inputs, parsed, ["answer", "code", "complexity"]);
  assert.equal(slot.present, false);
});

test("AR-C4 Correction invalidates G1 before failed G2; late G1 cleanup cannot erase accepted G2", () => {
  const slot = new UnpublishedArtifactSlot(), g1 = stable(), g2 = stable("G2");
  install(slot, g1); slot.clear();
  assert.equal(slot.present, false);
  const corrected = { ...inputs, manualCorrectionRevision: 1 };
  install(slot, g2, corrected);
  slot.accepted({ stable: g1, current: g2, target: target(g1), currentInputs: corrected });
  assert.equal(slot.take({ target: target(g2), stable: g2, inputs: corrected }).candidate?.suggestionId, "G2");
  install(slot, g2, corrected);
  assert.equal(slot.take({ target: target(g1), stable: g1, inputs: corrected }).reason, "generation-mismatch");
});

test("AR-C3/4 no-change candidate is discarded once and partial parsed output never enters", () => {
  const slot = new UnpublishedArtifactSlot();
  const answer = commitStableAnswerRevision({ current: stable(),
    candidate: { ...stable().suggestion, content, meetingAnswer: parsed }, authorizedArtifacts: ["answer", "code", "complexity"],
    taskId: "parent", logicalQuestionUnitId: "lqu", logicalQuestionRevision: 1,
    settlementId: "S1" })!;
  // Offer identical incidental content against the published artifact base.
  install(slot, answer);
  assert.equal(slot.take({ target: target(answer), stable: answer, inputs }).reason, "no-change");
  assert.equal(slot.present, false);
  install(slot, answer, inputs, { ...parsed, parseStatus: "partial" });
  assert.equal(slot.present, false);
});
