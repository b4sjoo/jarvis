import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/hooks/useMeetingAssistant.ts",
  "utf8"
);

test("publishes a Screen settlement only after its lifecycle receipt", () => {
  const start = source.indexOf(
    "// SCREEN_COMMITTED_SETTLEMENT_CONSUMER_BARRIER"
  );
  const end = source.indexOf(
    "const screenPostTransitionContextState",
    start
  );
  const block = source.slice(start, end);
  const transitionCommit = block.indexOf(
    "commitSourceOwnedTransitionWithManager({"
  );
  const transitionRejection = block.indexOf(
    "if (!screenTransitionCommitted)"
  );
  const settlementPublication = block.indexOf(
    "currentQuestionSettlementRef.current ="
  );
  const ledgerAdmissionStart = block.indexOf(
    "const screenEffectiveQuestionSourceRecord ="
  );
  const ledgerAdmissionEnd = block.indexOf(
    "if (screenEffectiveQuestionSourceRecord)",
    ledgerAdmissionStart
  );
  const ledgerAdmission = block.slice(
    ledgerAdmissionStart,
    ledgerAdmissionEnd
  );

  assert.ok(start >= 0 && end > start);
  assert.ok(transitionCommit >= 0);
  assert.ok(transitionRejection > transitionCommit);
  assert.ok(settlementPublication > transitionRejection);
  assert.match(
    block,
    /screenLifecyclePublicationAuthorized[\s\S]*sourceOwnedTransitionDurablySatisfied/
  );
  assert.match(
    block,
    /screenEffectiveQuestionSourceRecord[\s\S]*createEffectiveQuestionSourceRecord/
  );
  assert.ok(
    ledgerAdmissionStart >= 0 && ledgerAdmissionEnd > ledgerAdmissionStart
  );
  assert.match(
    ledgerAdmission,
    /screenLifecyclePublicationAuthorized\s*&&\s*!screenCurrentOnly/
  );
  assert.doesNotMatch(
    ledgerAdmission,
    /sourceOwnedTransitionDurablySatisfied/
  );
  assert.match(block, /committed-no-lifecycle-required/);
});

test("routes settled Screen policy through the shared execution plan", () => {
  const planStart = source.indexOf(
    "screenExecutionPlan = buildSettledAdvisorExecutionPlan({"
  );
  const providerStart = source.indexOf(
    "const screenUsesCodingModel =",
    planStart
  );
  const modelStart = source.indexOf(
    "let screenTaskContent = await withTimeout(",
    providerStart
  );
  const postModelStart = source.indexOf(
    "const screenResponseOwner = screenExecutionPlan.responseOwner",
    modelStart
  );
  const postModelEnd = source.indexOf(
    "const screenContinuityRelation",
    postModelStart
  );
  const preModelBlock = source.slice(planStart, modelStart);
  const postModelBlock = source.slice(postModelStart, postModelEnd);

  assert.ok(planStart >= 0 && providerStart > planStart);
  assert.ok(modelStart > providerStart);
  assert.ok(postModelStart > modelStart && postModelEnd > postModelStart);
  assert.match(preModelBlock, /requiresVision: true/);
  assert.match(preModelBlock, /screenExecutionPlan\.modelRoute/);
  assert.match(preModelBlock, /screenExecutionPlan\.requiredArtifacts/);
  assert.match(
    preModelBlock,
    /screenExecutionPlan\.questionTypeConsumerObservation/
  );
  assert.match(postModelBlock, /screenExecutionPlan\.artifactPolicy/);
  assert.doesNotMatch(postModelBlock, /resolveMeetingResponseOwner/);
  assert.doesNotMatch(postModelBlock, /authorizeResponseArtifactMutation/);
});
