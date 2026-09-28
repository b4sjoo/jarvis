import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { resolveEffectiveBranchPhase } from "../src/lib/meeting/active-branch-phase.js";
import { MeetingContextManager } from "../src/lib/meeting/context-manager.js";
import { createProvisionalCurrentQuestion, settleCurrentQuestion } from "../src/lib/meeting/current-question-settlement.js";
import { createEffectiveQuestionSourceRecord, EffectiveQuestionSourceLedger } from "../src/lib/meeting/effective-question-source-ledger.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";
import { getManualCorrectionCapabilities, type ManualCorrectionCapabilityContext, type ManualCorrectionIntent } from "../src/lib/meeting/manual-correction-intent.js";
import { prepareManualCorrectionIntentTransition } from "../src/lib/meeting/manual-correction-transition.js";
import { buildEffectiveAdvisorSettlementView, buildSettledAdvisorExecutionPlan } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import type { CanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { ActiveInterviewParent, SelectedInterviewPlaybook } from "../src/lib/meeting/types.js";

const sessionId = "correction-phase-plan";
const runtimeEpoch = 1;
const providers = { providers: [], selectedProvider: { provider: "unused", variables: {} }, codingProvider: { provider: "unused", variables: {} } };
type PreparedCorrection = Extract<ReturnType<typeof prepareManualCorrectionIntentTransition>, { authorized: true }>;
type PlanInput = Parameters<typeof buildSettledAdvisorExecutionPlan>[0];
type PhasePlanInput = Pick<PlanInput, "taskBoundaryCommitted" | "childOwnsResponse" | "playbook" |
  "contextReadScopeOverride" | "explicitTaskMutationCommand" | "taskMutationCommittedBeforeAdvisor" | "artifactRequest" | "subtaskIntent">;

// Execute the Hook's actual branch-to-playbook projection, then the real Plan
// builder. This excludes React/UI/provider setup without copying its selection.
function correctionPlaybookProjection() {
  const source = ts.createSourceFile("useMeetingAssistant.ts",
    readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let branch: ts.VariableStatement | undefined;
  let planArguments: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(
      declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "correctedBranch"
    )) branch = node;
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === "correctionExecutionPlan" &&
      ts.isCallExpression(node.right) && ts.isIdentifier(node.right.expression) && node.right.expression.text === "buildSettledAdvisorExecutionPlan" &&
      node.right.arguments[0] && ts.isObjectLiteralExpression(node.right.arguments[0])) {
      planArguments = node.right.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(branch && ts.isBlock(branch.parent), "production corrected branch projection");
  const selection = branch.parent.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(
    declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "correctedPlaybook"
  ));
  assert.ok(selection, "production corrected playbook projection in the same branch");
  assert.ok(planArguments, "production Correction Plan arguments");
  const properties = planArguments.properties;
  const names = ["taskBoundaryCommitted", "childOwnsResponse", "playbook", "contextReadScopeOverride",
    "explicitTaskMutationCommand", "taskMutationCommittedBeforeAdvisor", "artifactRequest", "subtaskIntent"];
  const phaseInputs = names.map(name => {
    const property = properties.find(node => ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name);
    assert.ok(property, `production Correction Plan ${name}`);
    return property.getText(source);
  });
  const code = ts.transpileModule([branch.getText(source), selection.getText(source),
    `({ correctedPlaybook, planPhaseInputs: { ${phaseInputs.join(",")} } })`].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return (correctionIntentTransition: PreparedCorrection, selectedCorrectionPlaybook: SelectedInterviewPlaybook) => vm.runInNewContext(code, {
    correctionIntentTransition, selectedCorrectionPlaybook, resolveEffectiveBranchPhase,
    parentAfter: correctionIntentTransition.parent, decision: correctionIntentTransition.decision,
    invocation: { correctionIntent: correctionIntentTransition.receipt.intent },
  }) as { correctedPlaybook: SelectedInterviewPlaybook; planPhaseInputs: PhasePlanInput };
}
const projectCorrectedPlaybook = correctionPlaybookProjection();

function question(id: string): LogicalQuestionUnit {
  const text = `Explain the implementation of ${id}.`;
  return { id, revision: 1, sessionId, runtimeEpoch, currentTurnId: `turn:${id}`, sourceTurnIds: [`turn:${id}`],
    sources: [{ turnId: `turn:${id}`, text, startedAt: 1, endedAt: 2 }], normalizedText: text,
    startedAt: 1, updatedAt: 2, compositionReasons: ["fresh-substantive-turn"], boundaryReason: "fresh-substantive-turn", truncated: false };
}

function parent(id: string, unit: LogicalQuestionUnit, type: "project-deep-dive" | "behavioral"): ActiveInterviewParent {
  const initial = selectInterviewPlaybook({ questionType: type, query: unit.normalizedText });
  assert.ok(initial);
  const phase = type === "project-deep-dive" ? "project_QA" : initial.phase;
  return { id, source: "voice", stableKind: type, topic: unit.normalizedText,
    playbook: { ...initial, phase }, playbookPhase: phase, phaseProgress: { [phase]: true },
    originQuestionId: `lqu:${unit.id}`, sourceQuestionUnitId: unit.id, sourceQuestionRevision: unit.revision,
    canonicalQuestionSourceTurnIds: unit.sourceTurnIds, startTurnId: unit.currentTurnId,
    supportedFactAnchors: [], revisions: 1, createdAt: 1, updatedAt: 1 };
}

function fixture() {
  const manager = new MeetingContextManager();
  manager.reset({ sessionId });
  const ledger = new EffectiveQuestionSourceLedger();
  manager.setEffectiveQuestionSourceLedger(ledger);
  const origin = question("project-origin");
  const original = parent("A", origin, "project-deep-dive");
  assert.equal(manager.commitTaskRuntimeTransition({ id: "install-A", transition: "create-parent", parent: original, reason: "fixture" }).mutationApplied, true);
  const fixture = { manager, ledger };
  admit(fixture, origin, "new-parent");
  return { ...fixture, original };
}

function admit(f: Pick<ReturnType<typeof fixture>, "manager" | "ledger">, unit: LogicalQuestionUnit,
  relation: "new-parent" | "followup-parent" | "child-probe") {
  const runtime = f.manager.getTaskRuntimeState();
  const task = buildActiveMeetingTask({ parent: runtime.parent, runtimeRevision: runtime.revision });
  assert.ok(task);
  const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
  const type = task.child?.questionType ?? task.parent.questionType;
  const settlement = settleCurrentQuestion({
    operationId: `admit:${unit.id}`, currentQuestion, activeParentId: task.parent.id,
    activeParentRevision: task.parent.revisions, manualCorrectionRevision: 0,
    deterministicProposal: { source: "deterministic-fast-path", sessionId, runtimeEpoch,
      logicalQuestionUnitId: unit.id, revision: unit.revision, sourceHash: currentQuestion.sourceHash,
      questionType: type, relation, action: "answer", confidence: 1,
      typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, actionEvidenceAuthorized: true,
      expectedParentId: task.parent.id, expectedParentRevision: task.parent.revisions },
    policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: true },
  });
  const effective = buildEffectiveAdvisorSettlementView({ settlement, activeMeetingTask: task,
    taskRuntimeRevision: runtime.revision, fallback: { questionType: type, relation } }).effectiveSettlement;
  assert.ok(effective);
  const record = createEffectiveQuestionSourceRecord({ logicalQuestionUnit: unit, settlement: effective, activeMeetingTask: task });
  assert.ok(record);
  f.ledger.upsert(record);
  assert.equal(f.manager.recordTaskQuestionAdmission({ sessionId, parentId: task.parent.id,
    childId: task.child?.id, logicalQuestionUnitId: unit.id }), true);
}

function correction(f: ReturnType<typeof fixture>, unit: LogicalQuestionUnit, correctedType: CanonicalQuestionType,
  kind: ManualCorrectionIntent["kind"]) {
  const runtime = f.manager.getTaskRuntimeState();
  const source = f.ledger.findLogicalQuestion({ sessionId, runtimeEpoch, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision });
  assert.ok(source);
  const currentQuestion = createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
  const context: ManualCorrectionCapabilityContext = {
    runtime, source, currentQuestion, currentSessionId: sessionId, currentRuntimeEpoch: runtimeEpoch, manualCorrectionRevision: 1,
    target: { sessionId, runtimeEpoch, logicalQuestionUnitId: unit.id, logicalQuestionRevision: unit.revision,
      sourceHash: currentQuestion.sourceHash, taskRuntimeRevision: runtime.revision, manualCorrectionRevision: 1, owner: source.owner },
    admission: f.manager.getManualCorrectionAdmission(), recentParent: f.manager.getRecentManualCorrectionParent(),
    recentParentSources: f.manager.getRecentManualCorrectionSources(runtimeEpoch),
  };
  const capability = getManualCorrectionCapabilities(context, correctedType).options.find(option => option.id === kind);
  assert.ok(capability, `available ${kind}`);
  const initial = selectInterviewPlaybook({ questionType: correctedType, query: unit.normalizedText });
  assert.ok(initial);
  const proposal = prepareManualCorrectionIntentTransition({ operationId: `correct:${unit.id}:${kind}`, context,
    correctedType, intent: capability.intent, correctedPlaybook: initial, newParentId: "unused", now: 10 });
  assert.equal(proposal.authorized, true);
  const { correctedPlaybook, planPhaseInputs } = projectCorrectedPlaybook(proposal, initial);
  const plan = buildSettledAdvisorExecutionPlan({
    settlement: proposal.settlement, executionRuntimeEpoch: runtimeEpoch,
    activeMeetingTask: proposal.activeMeetingTask,
    expectedActiveMeetingTask: buildActiveMeetingTask({ parent: runtime.parent, runtimeRevision: runtime.revision }),
    preBoundaryQuestionType: runtime.parent?.stableKind,
    providerSnapshot: providers,
    memoryUseCase: correctedType === "coding" ? "coding_interview" : "project_deep_dive",
    askFrame: "direct-answer", topicDomain: "backend", sourceQuestion: unit.normalizedText,
    parentSourceQuestion: proposal.parent.topic, promptCurrentQuestionSourceHash: proposal.settlement.sourceHash,
    ...planPhaseInputs,
  });
  return { initial, proposal, correctedPlaybook, plan };
}

test("Correction new Coding child keeps prepared implementation phase and requests Code in the production Plan", () => {
  const f = fixture();
  const q = question("new-coding-child");
  admit(f, q, "followup-parent");
  const { initial, proposal, correctedPlaybook, plan } = correction(f, q, "coding", "new-child");
  assert.equal(initial.phase, "baseline_reasoning");
  assert.equal(proposal.parent.child?.phaseState?.phase, "implementation_validation");
  assert.equal(correctedPlaybook.phase, "implementation_validation");
  assert.equal(plan.playbookPhase, "implementation_validation");
  assert.equal(plan.responsePlaybook?.phase, "implementation_validation");
  assert.deepEqual(plan.requestedArtifacts, ["answer", "code", "complexity"], JSON.stringify({ child: proposal.parent.child, artifactPolicy: plan.artifactPolicy, responseOwner: plan.responseOwner, artifactIntent: plan.artifactIntent }));
  assert.equal(proposal.parent.playbookPhase, "project_QA");
});

for (const previousType of ["coding", "field-knowledge"] as const) {
  test(`Correction continue ${previousType} child as Coding keeps implementation Code in the production Plan`, () => {
    const f = fixture();
    const q = question("child-question");
    admit(f, q, "followup-parent");
    const attached = correction(f, q, previousType, "new-child");
    assert.equal(f.manager.commitTaskRuntimeTransition({ id: "attach-child", transition: attached.proposal.transition,
      parent: attached.proposal.parent, reason: "fixture" }).mutationApplied, true);
    admit(f, q, "child-probe");
    const { initial, proposal, correctedPlaybook, plan } = correction(f, q, "coding", "continue-child");
    assert.equal(initial.phase, "baseline_reasoning");
    assert.equal(proposal.parent.child?.id, attached.proposal.parent.child?.id);
    assert.equal(proposal.parent.child?.phaseState?.phase, "implementation_validation");
    assert.equal(correctedPlaybook.phase, "implementation_validation");
    assert.equal(plan.playbookPhase, "implementation_validation");
    assert.deepEqual(plan.requestedArtifacts, ["answer", "code", "complexity"]);
    assert.equal(proposal.parent.playbookPhase, "project_QA");
  });
}

test("Correction recent PDD restore keeps committed QA instead of the fresh Summary catalog default", () => {
  const f = fixture();
  const q = question("B-origin");
  const b = parent("B", q, "behavioral");
  assert.equal(f.manager.commitTaskRuntimeTransition({ id: "replace-B", transition: "replace-parent", parent: b, reason: "fixture" }).mutationApplied, true);
  admit(f, q, "new-parent");
  const { initial, proposal, correctedPlaybook, plan } = correction(f, q, "project-deep-dive", "merge-recent-parent");
  assert.equal(initial.phase, "project_summary");
  assert.equal(proposal.parent.id, "A");
  assert.equal(proposal.parent.playbookPhase, "project_QA");
  assert.deepEqual(proposal.parent.phaseProgress, f.original.phaseProgress);
  assert.equal(correctedPlaybook.phase, "project_QA");
  assert.equal(plan.playbookPhase, "project_QA");
  assert.equal(plan.responsePlaybook?.phase, "project_QA");
  assert.equal(plan.contextReadScope, "active-parent-read");
  assert.deepEqual(plan.requestedArtifacts, ["answer"]);
});
