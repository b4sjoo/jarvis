import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";
import * as provenance from "../src/lib/meeting/relation-decision-provenance.js";
import * as settlement from "../src/lib/meeting/current-question-settlement.js";
import * as split from "../src/lib/meeting/task-relation-split-shadow.js";
import { createTaskRelationSettlementProposal } from "../src/lib/meeting/task-relation-adjudication.js";
import { resolveCorrectionOwnedTypeResettlement } from "../src/lib/meeting/correction-owned-resettlement.js";
import { consumeRevisionStableTopologyBinding } from "../src/lib/meeting/effective-question-source-ledger.js";
import { buildEffectiveAdvisorSettlementView, formatEffectiveAdvisorSettlementViewForTrace } from "../src/lib/meeting/settled-advisor-execution-plan.js";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import { buildSessionLongitudinalEvaluationReport } from "../scripts/lib/session-longitudinal-evaluation.js";
import type { LogicalQuestionUnit } from "../src/lib/meeting/logical-question-unit.js";

const hook = ts.createSourceFile("hook.ts", readFileSync("src/hooks/useMeetingAssistant.ts", "utf8"), ts.ScriptTarget.Latest, true);
function find(root: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  const visit = (n: ts.Node) => { if (predicate(n)) result ??= n; if (!result) ts.forEachChild(n, visit); };
  visit(root); assert.ok(result); return result;
}
function declaration(name: string, root = hook as ts.Node) {
  return find(root, n => ts.isVariableDeclaration(n) && n.name.getText(hook) === name) as ts.VariableDeclaration;
}
function run(source: string, env: object): any {
  return vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, env);
}
const unit: LogicalQuestionUnit = { id: "q", revision: 2, sessionId: "s", runtimeEpoch: 3,
  currentTurnId: "t", sourceTurnIds: ["t"], sources: [{ turnId: "t", text: "Design a queue", startedAt: 1, endedAt: 2 }],
  normalizedText: "Design a queue", startedAt: 1, updatedAt: 2, compositionReasons: [], boundaryReason: "new-question", truncated: false };

function ordered(stage: split.OrderedTaskRelationResolutionStage) {
  const decision = split.decideOrderedTaskRelationResolution({ sourceKind: "voice",
    currentQuestionType: "general-system-design", activeParentQuestionType: "general-system-design", hasActiveChild: false,
    parentAffinity: stage === "runtime-matrix" ? { schemaVersion: 1, affinityKind: "parent", decision: "related", confidence: .99,
      currentEvidenceSpans: ["Design a queue"], branchEvidenceSpans: ["queue"] } : undefined,
    canonical: stage === "canonical-relation" ? { schemaVersion: 3, relation: "followup-parent", confidence: .99,
      currentQuestionEvidenceSpans: ["Design a queue"], parentEvidenceSpans: ["queue"] } : undefined,
    finalizeWithNullHypothesis: true });
  assert.equal(decision.stage, stage);
  return decision;
}

function produce(entry: "voice" | "screen" | "term", decision: split.OrderedTaskRelationResolutionDecision) {
  const q = settlement.createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: entry === "screen" ? "screen" : "voice",
    sourceObservationIds: entry === "screen" ? ["screen"] : undefined });
  const parent = { id: "parent", revisions: 3, questionType: "general-system-design" };
  const local = { source: "deterministic-fast-path", ...q, questionType: parent.questionType, relation: "unknown", action: "answer",
    confidence: .99, typeEvidenceAuthorized: true, relationEvidenceAuthorized: false, actionEvidenceAuthorized: true,
    expectedParentId: parent.id, expectedParentRevision: 3 };
  const env = { ...provenance, ...settlement, ...split, createTaskRelationSettlementProposal, resolveCorrectionOwnedTypeResettlement,
    currentQuestion: q, orderedRelation: decision, latestParent: parent, resolvedQuestionType: parent.questionType,
    orderedType: { questionType: parent.questionType, stage: "runtime-llm", confidence: .99, typeEvidenceAuthorized: true },
    authoritativeTypeSettlement: { questionType: parent.questionType, confidence: .99 }, resolvedOrderedRelation: decision.relation ?? "none",
    taskRelationHandle: { operationId: "relation-op", deterministicProposal: local }, outcome: { operationId: "type-op" },
    manualCorrectionRevisionRef: { current: 0 }, screenCurrentQuestion: q, screenQuestionComplete: true,
    coordinatedRelation: decision, screenDeterministicSettlementProposal: local,
    taskRelationAdjudicationHandle: { operationId: "relation-op" }, preflightContextState: { activeMeetingTask: { parent } } };
  if (entry === "voice") {
    const root = declaration("dispatchAdvisor");
    const names = ["localProposal", "relationCandidate", "relationProposal", "authoritativeTypeProposal",
      "deterministicOrderedRelationProposal", "settlementOperationId", "settlement"];
    return run(`(() => { ${names.map(name => declaration(name, root).parent.parent.getText(hook)).join("\n")} return settlement; })()`, env);
  }
  if (entry === "screen") {
    const create = find(hook, n => ts.isBinaryExpression(n) && n.left.getText(hook) === "screenCurrentQuestionSettlement" &&
      n.right.getText(hook).includes("orderedDeterministicProposal"));
    return run(`(() => { ${["releasedRelationCandidate", "orderedDeterministicProposal", "llmRelationProposal"].map(name => declaration(name).parent.parent.getText(hook)).join("\n")}
      let screenCurrentQuestionSettlement; ${create.getText(hook)}; return screenCurrentQuestionSettlement; })()`, env);
  }
  const call = find(hook, n => ts.isCallExpression(n) && n.expression.getText(hook) === "resolveCorrectionOwnedTypeResettlement");
  return run(`(${call.getText(hook)})`, { ...env, application: { logicalQuestionUnit: unit }, correctionSourceKind: "voice",
    correctionDecisionBackend: { kind: "existing" },
    targetSourceObservationIds: [], outcome: { candidate: { questionType: parent.questionType, confidence: .99 }, operationLeaseAuthorized: true },
    latestParentType: parent.questionType, correctionTargetOwnsActiveParent: true, effectiveOrderedRelation: decision.relation,
    revisionStableTopologyBinding: undefined, correctionCurrentQuestion: q, correctionCoordinatorDecision: { relation: decision, reason: decision.reason },
    correctionRelationHandle: { operationId: "relation-op" } }).settlement;
}

for (const entry of ["voice", "screen", "term"] as const) for (const stage of ["runtime-matrix", "canonical-relation", "source-topology-null-hypothesis"] as const) {
  test(`actual ${entry} proposal -> selected settlement -> recording -> report: ${stage}`, () => {
    const result = produce(entry, ordered(stage));
    assert.equal(result.orderedRelationProvenance.stage, stage);
    const view = buildEffectiveAdvisorSettlementView({ settlement: result, taskRuntimeRevision: 1,
      fallback: { questionType: "general-system-design", relation: "unknown" } });
    const metadata = { ...settlement.formatCurrentQuestionSettlementForTrace(result), ...formatEffectiveAdvisorSettlementViewForTrace(view) };
    const observation = provenance.observeRelationDecisionProvenance(metadata);
    assert.equal(observation.ordered?.operationId, "relation-op");
    assert.equal(observation.executionSource, result.relationAuthoritySource);
    const trace = { id: "trace", kind: "voice" as const, status: "success" as const, startedAt: 1,
      metadata, steps: [], inputs: [], outputs: [] };
    const summary = buildCompactTraceSummary({ sessionId: "s", trace, trigger: "manual", traceExportPath: "t.json", summaryPath: "summary.json" });
    assert.deepEqual(summary.relationDecisionProvenance, observation);
    assert.equal(provenance.observeRelationDecisionProvenance(settlement.formatCurrentQuestionSettlementForTrace(result)).ordered, undefined);
    const report = buildSessionLongitudinalEvaluationReport([{ directory: "fixture", manifest: { sessionId: "s" },
      transcriptTurns: [], traceSummaries: [JSON.parse(JSON.stringify(summary))], questionEvaluations: [] }]);
    assert.equal(report.relationDecisionSources.confirmedOrderedCount, 1);
    assert.equal(report.relationDecisionSources.rows[0].provenance?.ordered?.stage, stage);
  });
}

test("same-valued unselected Canonical, manual override, stale identity and revision-stable override never inherit provenance", () => {
  const q = settlement.createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "voice" });
  const decision = ordered("canonical-relation");
  const local: settlement.CurrentQuestionSettlementProposal = { ...q, source: "deterministic-fast-path", relation: "followup-parent",
    questionType: "general-system-design", typeEvidenceAuthorized: true, relationEvidenceAuthorized: true, confidence: 1 };
  const llm = { ...local, source: "runtime-adjudication" as const, orderedRelationProvenance: provenance.createOrderedRelationProvenance(q, decision, "losing-op") };
  const input = { currentQuestion: q, deterministicProposal: local, runtimeRelationProposal: llm,
    manualCorrectionRevision: 0, policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: false, allowLlmRelationRepair: true } };
  assert.equal(settlement.settleCurrentQuestion(input).orderedRelationProvenance, undefined);
  const withProvenance = settlement.settleCurrentQuestion({ ...input, deterministicProposal: { ...local, orderedRelationProvenance: llm.orderedRelationProvenance } });
  const withoutProvenance = settlement.settleCurrentQuestion(input);
  assert.deepEqual({ ...withProvenance, orderedRelationProvenance: undefined }, withoutProvenance);
  const manual = settlement.settleCurrentQuestion({ ...input, manualProposal: { ...llm, source: "manual-correction", manualCorrectionRevision: 0 } });
  assert.equal(manual.orderedRelationProvenance, undefined);
  for (const patch of [{ sessionId: "other" }, { revision: 1 }, { runtimeEpoch: 0 }, { sourceHash: "stale" }, { logicalQuestionUnitId: "other" }]) {
    const result = settlement.settleCurrentQuestion({ ...input, deterministicProposal: { ...local,
      orderedRelationProvenance: { ...llm.orderedRelationProvenance!, ...patch } } });
    assert.equal(result.orderedRelationProvenance, undefined);
    assert.equal(result.relation, "followup-parent");
  }
  const revision = consumeRevisionStableTopologyBinding({ settlement: withProvenance, logicalQuestionUnit: unit,
    binding: { relation: "followup-parent", owner: { kind: "parent-mainline", parentId: "parent" }, source: "effective-question-source-ledger", boundRevision: 1 } });
  assert.equal(revision.consumed, true);
  assert.equal(revision.settlement.orderedRelationProvenance, undefined);
  assert.equal(provenance.observeRelationDecisionProvenance(settlement.formatCurrentQuestionSettlementForTrace(revision.settlement)).ordered, undefined);
});

test("legacy, missing and conflicting effective identities remain unconfirmed without changing Relation", () => {
  const result = produce("screen", ordered("canonical-relation"));
  const metadata = settlement.formatCurrentQuestionSettlementForTrace(result);
  assert.equal(provenance.observeRelationDecisionProvenance({ taskRelationOrderedResolutionStage: "canonical-relation" }).ordered, undefined);
  for (const patch of [{ currentQuestionSettlementOrderedRelationProvenance: null },
    { effectiveCurrentQuestionSettlementMaterialized: true, effectiveCurrentQuestionSettlementId: "other" },
    { currentQuestionSettlementRevision: 9 }, { currentQuestionSettlementRelation: "new-parent" }]) {
    assert.equal(provenance.observeRelationDecisionProvenance({ ...metadata, ...patch }).ordered, undefined);
  }
});

test("the Screen direct Source Linkage proposal does not borrow a same-valued Ordered observation", () => {
  const q = settlement.createProvisionalCurrentQuestion({ logicalQuestionUnit: unit, sourceKind: "screen", sourceObservationIds: ["screen"] });
  const assignment = find(hook, n => ts.isBinaryExpression(n) && n.left.getText(hook) === "screenDeterministicSettlementProposal" &&
    n.right.getText(hook).includes("screenDirectRelationAuthority"));
  const direct = run(`(() => { let screenDeterministicSettlementProposal; ${assignment.getText(hook)}; return screenDeterministicSettlementProposal; })()`, {
    screenCurrentQuestion: q, screenMemoryQuestionType: "general-system-design", screenDirectRelationAuthority: true,
    localScreenTaskRelation: "followup-parent", screenTypeConfidence: 1, screenSectionHintConsumption: { disposition: "none" },
    screenTaskRelationDecision: { confidence: 1 }, screenTypeEvidenceAuthorized: true, localScreenRelationEvidenceAuthorized: true,
    manualCorrectionRevisionRef: { current: 0 }, preflightContextState: {}, screenTypeAuthoritySource: "preflight",
  });
  const result = settlement.settleCurrentQuestion({ currentQuestion: q, deterministicProposal: direct, manualCorrectionRevision: 0,
    runtimeRelationProposal: { ...direct, source: "runtime-adjudication", orderedRelationProvenance:
      provenance.createOrderedRelationProvenance(q, ordered("canonical-relation"), "trace-only-loser") },
    policy: { runtimeMutationAuthorized: true, questionComplete: true, commitParent: false, allowLlmRelationRepair: true } });
  assert.equal(result.relation, "followup-parent");
  assert.equal(result.relationAuthoritySource, "deterministic-fast-path");
  assert.equal(result.orderedRelationProvenance, undefined);
});
