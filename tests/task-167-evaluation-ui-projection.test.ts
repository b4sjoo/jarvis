import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildHumanEvaluationAttemptEvidenceV2 } from "../src/lib/meeting/human-evaluation-attempt-projection.js";
import {
  buildHumanEvaluationObservedSnapshotV2,
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
  evaluateTaskSettlementTupleCompatibilityV2,
  freezeObservedTaskOwnerIdentityV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";
import { hnswTrace, hnswHumanFacts, hnswProvenance } from "./fixtures/task-167-evaluation-ui-hnsw.js";

function observed(metadata: Record<string, unknown>, status: MeetingTrace["status"] = "success") {
  const trace = { ...hnswTrace, status, metadata };
  const result = buildHumanEvaluationAttemptEvidenceV2({ trace, traces: [trace] }).observed;
  assert.deepEqual(result, buildHumanEvaluationObservedSnapshotV2(trace));
  return result;
}

test("A1-C1: recorded HNSW projects final none/preserve, not rejected resume", () => {
  const original = JSON.stringify({ hnswTrace, hnswHumanFacts });
  const result = observed(hnswTrace.metadata!);
  assert.equal(result.relation, "none");
  assert.equal(result.parentAction, "preserve");
  assert.equal(result.adviseOnly, true);
  assert.equal(result.adviseOnlyReason, "canonical-topology-incompatible");
  assert.equal(result.settledParentId, undefined, "response owner must not borrow the preserved durable parent");
  assert.equal(evaluateTaskSettlementTupleCompatibilityV2({ relation: result.relation!, parentAction: result.parentAction! }).compatible, true);
  const event = hnswHumanFacts[0]!;
  const projection = deriveHumanEvaluationProjectionV2({ sessionId: event.sessionId, subject: event.subject, events: hnswHumanFacts, observed: result });
  assert.equal(projection.verdicts.relationCorrect, false);
  assert.equal(projection.verdicts.parentActionCorrect, false);
  assert.equal(JSON.stringify({ hnswTrace, hnswHumanFacts }), original);
});

test("A1-C2: ordinary artifact Answer-only and first-parent current-only are not Advise-only", () => {
  const followup = observed({ ...hnswTrace.metadata,
    settledExecutionPlanRelation: "followup-parent", settledExecutionPlanRelationApplicable: true,
    settledExecutionPlanContextReadScope: "active-parent-read", settledExecutionPlanResponseOwnerSource: "committed-parent",
  });
  assert.equal(followup.relation, "followup-parent");
  assert.equal(followup.parentAction, "preserve");
  assert.equal(followup.adviseOnly, undefined);
  const first = observed({ ...hnswTrace.metadata, settledExecutionPlanRelation: "new-parent",
    settledExecutionPlanRelationApplicable: true, settledExecutionPlanTaskMutationCommand: "create-parent" });
  assert.equal(first.relation, "new-parent");
  assert.equal(first.parentAction, "create");
  assert.equal(first.adviseOnly, undefined);
});

test("A1-C2: no-parent and Personal Status retain their actual reasons", () => {
  const metadata = { ...hnswTrace.metadata };
  for (const key of Object.keys(metadata)) {
    if (/Parent|Child/.test(key) && !/ParentMutation|ParentScope/.test(key)) delete metadata[key];
  }
  metadata.taskRelationOrderedResolutionReason = "no-parent-current-question";
  const noParent = observed(metadata);
  assert.equal(noParent.relation, "none");
  assert.equal(noParent.parentAction, "none");
  assert.equal(noParent.adviseOnly, true);
  assert.equal(noParent.adviseOnlyReason, "no-parent-current-question");
  const personal = observed({ ...metadata, settledExecutionPlanResponseOwnerSource: "transient-personal-status",
    settledExecutionPlanTransientPersonalStatusDisposition: "domain-resolved-unknown" });
  assert.equal(personal.adviseOnly, true);
  assert.equal(personal.adviseOnlyReason, "domain-resolved-unknown");
});

test("A1-C3: completed fallback and settled semantics survive a later Advisor error", () => {
  for (const failure of ["timeout", "invalid-json"]) {
    const result = observed({ ...hnswTrace.metadata, currentQuestionSettlementRelation: "unknown",
      taskRelationSplitCanonicalDisposition: failure, taskRelationOrderedResolutionReason: "no-parent-current-question" }, "error");
    assert.equal(result.relation, "none");
    assert.equal(result.parentAction, "preserve");
    assert.equal(result.adviseOnly, true);
  }
});

test("A1-C3/C4: missing, unfinished, cancelled and rejected evidence cannot invent preserve or Advise-only", () => {
  for (const status of ["running", "cancelled", "error", "success"] as const) {
    const result = observed({ effectiveAdvisorCurrentOnly: true,
      currentQuestionSettlementRelation: "unknown", activeMeetingParentId: "parent-existing" }, status);
    assert.equal(result.parentAction, undefined);
    assert.equal(result.adviseOnly, undefined);
  }
  for (const relation of ["new-parent", "followup-parent", "child-probe", "resume-parent", "none"]) {
    const result = observed({ currentQuestionSettlementRelation: relation,
      currentQuestionSettlementParentMutationAuthorized: true, activeMeetingParentId: "parent-existing" });
    assert.equal(result.parentAction, undefined);
    assert.equal(result.adviseOnly, undefined);
  }
  const rejected = observed({ ...hnswTrace.metadata, settledExecutionPlanAuthorized: false });
  assert.equal(rejected.parentAction, undefined);
  assert.equal(rejected.adviseOnly, undefined);
  const unfinished = { ...hnswTrace.metadata, settledExecutionPlanAuthorized: undefined };
  assert.equal(observed(unfinished, "running").parentAction, undefined);
  assert.equal(observed(unfinished, "cancelled").adviseOnly, undefined);
  const missingTree = { ...hnswTrace.metadata };
  for (const key of ["settledExecutionPlanExpectedParentId", "settledExecutionPlanPostMutationParentId",
    "currentQuestionSettlementParentBeforeId", "currentQuestionSettlementParentAfterId"]) delete missingTree[key];
  assert.equal(observed(missingTree).parentAction, undefined);
});

test("A1-C4: durable receipt wins over current-only preserve and partial receipts remain missing", () => {
  for (const [command, action] of [["create-parent", "create"], ["replace-parent", "retype"],
    ["attach-child", "attach-child"], ["resume-parent", "resume"]]) {
    const metadata = { ...hnswTrace.metadata, sourceTransitionRuntimeKind: command,
      sourceTransitionDurableAuthorized: true, sourceTransitionDurableMutationApplied: true,
      sourceTransitionParentBeforeId: "parent-1", sourceTransitionParentAfterId: "parent-1",
      sourceTransitionParentBeforeType: "coding", sourceTransitionParentAfterType: "field-knowledge" };
    const result = observed(metadata, "error");
    assert.equal(result.parentAction, action);
    assert.equal(result.adviseOnly, undefined);
  }
  assert.equal(observed({ ...hnswTrace.metadata, sourceTransitionRuntimeKind: "replace-parent",
    sourceTransitionDurableAuthorized: true, sourceTransitionDurableMutationApplied: true }).parentAction, undefined);
});

test("A1-C5: confirmed none/preserve survives event serialization and reprojecting without rewriting old human facts", () => {
  const original = JSON.stringify(hnswHumanFacts);
  const prior = hnswHumanFacts[0]!;
  const result = observed(hnswTrace.metadata!);
  const event = createHumanGroundTruthEventV2({ sessionId: prior.sessionId, subject: prior.subject,
    source: "explicit-ui", confirmation: "confirmed", supersedesEventId: prior.eventId,
    fact: { kind: "expected-task-settlement", expectedQuestionType: result.questionType!,
      expectedRelation: result.relation!, expectedParentAction: result.parentAction!,
      ...freezeObservedTaskOwnerIdentityV2(result) } });
  const events = JSON.parse(JSON.stringify([...hnswHumanFacts, event]));
  const projection = deriveHumanEvaluationProjectionV2({ sessionId: prior.sessionId, subject: prior.subject, events, observed: result });
  assert.equal(projection.verdicts.taskSettlementCorrect, true);
  assert.deepEqual(projection.activeFacts["expected-task-settlement"]?.fact, JSON.parse(JSON.stringify(event.fact)));
  assert.equal(JSON.stringify(hnswHumanFacts), original);
});

test("A1-C5: available sealed originals retain their hashes and the bounded fixture is verbatim", (t) => {
  const root = path.join(os.homedir(), "Library/Application Support/dev.seasonsg.jarvis/meeting-session-recordings", hnswProvenance.session);
  if (!existsSync(root)) return t.skip("original recording is local-only; frozen fixture remains portable");
  for (const [file, hash] of [[hnswProvenance.tracePath, hnswProvenance.traceSha256], [hnswProvenance.truthPath, hnswProvenance.truthSha256]]) {
    assert.equal(createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"), hash);
  }
  const original = JSON.parse(readFileSync(path.join(root, hnswProvenance.tracePath), "utf8")).trace;
  for (const [key, value] of Object.entries(hnswTrace.metadata!)) assert.deepEqual(value, original.metadata[key], key);
  const facts = readFileSync(path.join(root, hnswProvenance.truthPath), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(hnswHumanFacts[0], facts.find(event => event.eventId === hnswHumanFacts[0]!.eventId));
});

test("A1-C5: production store commit/read and observation refresh retain original human facts", async () => {
  const file = "src/lib/meeting/human-evaluation-store.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "createHumanEvaluationStore");
  assert.ok(declaration);
  const createStore = vm.runInNewContext(ts.transpileModule(
    declaration.getText(source).replace(/^export\s+/, "") + "\ncreateHumanEvaluationStore;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText, { structuredClone, deriveHumanEvaluationProjectionV2, IMPORT_SOURCE: "unused-import" });
  const oldBytes = JSON.stringify(hnswHumanFacts);
  let stored = { events: JSON.parse(oldBytes), projections: [] as unknown[] };
  const store = createStore({
    initialize: async () => {}, readLegacy: () => null,
    invoke: async (command: string, args: any) => {
      if (command === "evaluation_store_import_status") return true;
      if (command === "evaluation_store_read") return JSON.parse(JSON.stringify(stored));
      if (command === "evaluation_store_append") {
        const input = JSON.parse(JSON.stringify(args.input));
        stored.events.push(input.event);
        stored.projections = [input.projection];
        return input;
      }
      assert.equal(command, "evaluation_store_project");
      stored.projections = [JSON.parse(JSON.stringify(args.projection))];
      return stored.projections[0];
    },
  });
  const prior = hnswHumanFacts[0]!;
  const result = observed(hnswTrace.metadata!);
  const event = createHumanGroundTruthEventV2({ sessionId: prior.sessionId, subject: prior.subject,
    source: "explicit-ui", confirmation: "confirmed", supersedesEventId: prior.eventId,
    fact: { kind: "expected-task-settlement", expectedQuestionType: result.questionType!,
      expectedRelation: "none", expectedParentAction: "preserve", ...freezeObservedTaskOwnerIdentityV2(result) } });
  const committed = await store.commit(event, result);
  assert.equal(committed.projection.verdicts.taskSettlementCorrect, true);
  const refresh = deriveHumanEvaluationProjectionV2({ sessionId: prior.sessionId, subject: prior.subject, events: [], observed: result });
  await store.saveObservation(refresh);
  const loaded = await store.readSession(prior.sessionId);
  assert.equal(JSON.stringify(loaded.events.slice(0, 1)), oldBytes);
  assert.equal(loaded.projections[0].activeFacts["expected-task-settlement"].fact.expectedParentAction, "preserve");
  assert.equal(loaded.projections[0].observed.parentAction, "preserve");
});
