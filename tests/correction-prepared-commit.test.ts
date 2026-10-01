import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { applyActiveQuestionTermCorrection, authorizeActiveQuestionTermCorrection } from "../src/lib/meeting/active-question-term-correction.js";
import { correctionTargetOwnsParentOrigin, resolveCorrectionOwnedTypeResettlement } from "../src/lib/meeting/correction-owned-resettlement.js";
import { applyManualQuestionTypeCorrectionToParent, decideManualQuestionTypeCorrection } from "../src/lib/meeting/manual-question-type-correction.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import { resolvePreparationRuntimeReinforcement } from "../src/lib/meeting/preparation-runtime-consumers.js";
import { createNeutralPreparationRuntimeContext } from "../src/lib/meeting/preparation-runtime-context.js";
import { toMemoryUseCaseForQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import type { ActiveInterviewParent } from "../src/lib/meeting/types.js";
import { productionPlannedCommit } from "./helpers/planned-task-runtime-commit.js";
import { prepareManualCorrectionIntentTransition } from "../src/lib/meeting/manual-correction-transition.js";
import { createProvisionalCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { topicHookFunction } from "./helpers/task-189-topic-hook.js";

const source = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function termExpression(name: string) {
  const matches: ts.VariableDeclaration[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(source) === name &&
      (name !== "correctionPlanInput" || n.getText(source).includes("settledCorrection"))) matches.push(n);
    ts.forEachChild(n, visit);
  };
  visit(source);
  assert.equal(matches.length, 1, name);
  return new vm.Script(ts.transpileModule(`(${matches[0].initializer!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText);
}
const parentExpression = termExpression("resettledParent");
const planExpression = termExpression("correctionPlanInput");

function termFixture() {
  const unit: LogicalQuestionUnit = { id: "q", revision: 1, sessionId: "s", runtimeEpoch: 2,
    currentTurnId: "t", sourceTurnIds: ["t"], normalizedText: "Design a rhyme system for trip planning.",
    sources: [{ turnId: "t", text: "Design a rhyme system for trip planning.", startedAt: 1, endedAt: 2 }],
    startedAt: 1, updatedAt: 2, compositionReasons: [], boundaryReason: "new-question", truncated: false };
  const manager = new MeetingContextManager(); manager.reset({ sessionId: "s" });
  const before: ActiveInterviewParent = { id: "p", source: "voice", stableKind: "general-system-design", topic: unit.normalizedText,
    sourceQuestionUnitId: unit.id, sourceQuestionRevision: 1, canonicalQuestionSourceTurnIds: ["t"], startTurnId: "t",
    revisions: 3, createdAt: 1, updatedAt: 2, playbookPhase: "design_framing", phaseProgress: {}, supportedFactAnchors: [] };
  assert.equal(manager.commitTaskRuntimeTransition({ id: "seed", transition: "create-parent", parent: before, reason: "fixture" }).authorized, true);
  const application = applyActiveQuestionTermCorrection({ logicalQuestionUnit: unit,
    correction: { id: "term", input: "rhyme -> RAG", term: "RAG", from: "rhyme", to: "RAG", createdAt: 3, appliedCount: 0 },
    correctionTraceId: "trace", manualCorrectionRevision: 1, now: 3 });
  const correctionOwnedResettlement = resolveCorrectionOwnedTypeResettlement({
    logicalQuestionUnit: application.logicalQuestionUnit, operationAuthorized: true,
    adjudication: { schemaVersion: 1, questionType: "ai-ml-system-design", confidence: 0.96, evidenceSpans: ["RAG system"] },
    activeParentId: before.id, activeParentRevision: before.revisions, activeParentType: before.stableKind,
    targetOwnsActiveParent: correctionTargetOwnsParentOrigin({ logicalQuestionUnit: application.logicalQuestionUnit, parent: before }),
    manualCorrectionRevision: 1, orderedRelation: "new-parent" });
  assert.equal(correctionOwnedResettlement.parentMutationAuthorized, true);
  const latestContext = manager.getState(), latestTask = latestContext.activeMeetingTask!;
  const correctedPlaybook = selectInterviewPlaybook({ questionType: "ai-ml-system-design", query: application.logicalQuestionUnit.normalizedText });
  const env: Record<string, unknown> = {
    application, lifecycleParentBefore: before, typeCorrectionDecision: decideManualQuestionTypeCorrection(latestTask, "ai-ml-system-design"),
    correctedPlaybook, applyManualQuestionTypeCorrectionToParent, correctionOwnedResettlement,
    correctedSemanticEvidenceText: application.logicalQuestionUnit.normalizedText,
    correctedLineage: { questionInstanceId: "lqu:q" },
  };
  const parentAfter = parentExpression.runInNewContext(env) as ActiveInterviewParent;
  Object.assign(env, {
    correctionExecutionEpoch: 2, settledCorrection: correctionOwnedResettlement.settlement,
    latestContext, latestParent: latestTask.parent, correctedType: "ai-ml-system-design", resettledScreenTask: undefined,
    meetingModelProviderSnapshotRef: { current: { providers: [], selectedProvider: { provider: "unused", variables: {} }, codingProvider: { provider: "unused", variables: {} } } },
    preparationRuntimeContextRef: { current: createNeutralPreparationRuntimeContext({ meetingSessionId: "s", preparationContextRevision: 0 }) }, resolvePreparationRuntimeReinforcement,
    toMemoryUseCaseForQuestionType, inferMemoryUseCaseFromQuery: topicHookFunction("inferMemoryUseCaseFromQuery"),
    askFrame: "hypothetical-design", topicDomain: "ai-ml-infra",
    projectedActiveMeetingTask: buildActiveMeetingTask({ parent: parentAfter, runtimeRevision: 2 }),
    readEffectiveSemanticTask: (task: unknown) => task,
  });
  const planInput = planExpression.runInNewContext(env);
  return { manager, before, unit, application, parentAfter, planInput, latestContext };
}

test("Term overlay, inferred Type/Relation, actual Hook packing and shared Plan commit keep one origin owner", () => {
  const f = termFixture(); let prepares = 0;
  const prepare = f.manager.prepareTaskRuntimeTransition.bind(f.manager);
  f.manager.prepareTaskRuntimeTransition = input => { prepares++; return prepare(input); };
  const result = productionPlannedCommit()({ manager: f.manager, currentContext: f.latestContext,
    currentLogicalQuestionUnit: f.application.logicalQuestionUnit, parentAfter: f.parentAfter, screenAfter: null,
    operationId: "term-commit", planInput: f.planInput });
  assert.equal(result.authorized, true, result.reason);
  assert.equal(prepares, 1);
  assert.strictEqual(result.runtimeResult, result.prepared.result);
  assert.equal(result.plan.taskSnapshot.parent.id, "p");
  assert.equal(result.plan.taskSnapshot.parent.revisions, 4);
  assert.match(result.plan.taskSnapshot.parent.topic, /RAG/);
  assert.equal(result.plan.taskMutationPolicy.topic, f.parentAfter.topic);
  assert.equal(f.application.logicalQuestionUnit.revision, 2);
  assert.match(f.unit.normalizedText, /rhyme/);
  assert.equal(result.lifecycleMetadata.taskLifecycleParentAfterType, "ai-ml-system-design");
  assert.equal(result.plan.taskMutationCommittedBeforeAdvisor, true);
});

for (const change of ["clear", "clear-recreate", "new-parent", "parent-revision"] as const) {
  test(`shared commit rejects ${change} after Correction context capture`, () => {
    const f = termFixture();
    if (change === "clear" || change === "clear-recreate") {
      f.manager.reset({ sessionId: "other-session" });
      if (change === "clear-recreate") f.manager.commitTaskRuntimeTransition({
        id: "new-session-parent", reason: "fixture", transition: "create-parent", parent: f.before });
    }
    else f.manager.commitTaskRuntimeTransition({ id: "interleave", reason: "newer-input",
      transition: change === "new-parent" ? "replace-parent" : "update-parent-context",
      parent: { ...f.before, id: change === "new-parent" ? "B" : "p", revisions: 4 } });
    const before = f.manager.getTaskRuntimeState();
    const result = productionPlannedCommit()({ manager: f.manager, currentContext: f.latestContext,
      currentLogicalQuestionUnit: f.application.logicalQuestionUnit, parentAfter: f.parentAfter, screenAfter: null,
      operationId: "stale", planInput: f.planInput });
    assert.equal(result.authorized, false);
    assert.deepEqual(f.manager.getTaskRuntimeState(), before);
    assert.equal(result.lifecycleMetadata.taskLifecycleMutationApplied, false);
  });
}

test("stale manual revision remains rejected by the existing Term source authorizer", () => {
  const f = termFixture();
  const result = authorizeActiveQuestionTermCorrection({ transaction: f.application.transaction,
    currentLogicalQuestionUnit: f.application.logicalQuestionUnit, currentSessionId: "s", currentRuntimeEpoch: 2,
    currentManualCorrectionRevision: 2 });
  assert.equal(result.reason, "manual-correction-revision-mismatch");
  assert.equal(result.authorized, false);
});

test("explicit no-parent Type correction compiles a create Plan without inventing a preexisting owner", () => {
  const f = termFixture(); f.manager.reset({ sessionId: "s" });
  const currentContext = f.manager.getState();
  const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: f.unit, sourceKind: "voice" });
  const proposal = prepareManualCorrectionIntentTransition({ operationId: "first", correctedType: "general-system-design",
    intent: { kind: "independent" }, newParentId: "first-parent", now: 3,
    context: { currentQuestion, currentSessionId: "s", currentRuntimeEpoch: 2, manualCorrectionRevision: 1,
      runtime: currentContext.taskRuntime, target: { sessionId: "s", runtimeEpoch: 2,
        logicalQuestionUnitId: f.unit.id, logicalQuestionRevision: f.unit.revision,
        sourceHash: currentQuestion.sourceHash, taskRuntimeRevision: 0, manualCorrectionRevision: 1 } } });
  assert.equal(proposal.authorized, true);
  const result = productionPlannedCommit()({ manager: f.manager, currentContext,
    currentLogicalQuestionUnit: f.unit, operationId: "first", parentAfter: proposal.parent, screenAfter: null,
    planInput: { ...f.planInput, settlement: proposal.settlement, explicitTaskMutationCommand: proposal.command,
      promptCurrentQuestionSourceHash: proposal.settlement.sourceHash, sourceQuestion: f.unit.normalizedText } });
  assert.equal(result.authorized, true, result.reason);
  assert.equal(result.plan.expectedParentId, undefined);
  assert.equal(result.plan.postMutationParentId, "first-parent");
  assert.equal(result.plan.taskMutationPolicy.kind, "create-parent");
  assert.equal(result.runtimeResult.state.parent.revisions, 1);
});
