import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ActiveCallRuntime } from "../src/lib/calling/index.js";
import {
  RuntimeHandoffService,
  createNeutralRuntimePreparation,
  createPreparedRuntimePreparation,
  type CallPreparationSnapshotBundle,
  type SqlDatabase,
} from "../src/lib/preparation/index.js";

const bundle = (): CallPreparationSnapshotBundle => ({
  id: "snapshot-1",
  compileId: "compile-1",
  caseId: "case-1",
  caseRevisionId: "case-revision-1",
  callPlanId: "plan-1",
  version: 1,
  state: "ready",
  caseSnapshot: {
    objective: "Resolve the charge",
    acceptableFallbacks: ["Written review"],
    supportedStatements: [],
    disputedClaims: [],
    unknowns: [],
    commitments: [],
    deadlines: [],
    nextActions: [],
  },
  callBrief: {
    objective: "Obtain a billing correction",
    counterpartyNames: ["Support"],
    acceptableOutcomes: ["Refund"],
    questionsToAsk: ["What reference number applies?"],
    knownRisks: ["No written confirmation"],
  },
  playbookSnapshot: {
    stages: [
      { id: "orient", goal: "Orient", prompts: [], exitSignals: [] },
      { id: "establish", goal: "Establish", prompts: [], exitSignals: [] },
      { id: "request", goal: "Request", prompts: [], exitSignals: [] },
      { id: "resolve", goal: "Resolve", prompts: [], exitSignals: [] },
      { id: "confirm-close", goal: "Close", prompts: [], exitSignals: [] },
    ],
    fallbackMoves: [],
  },
  speechBiasTerms: [{ term: "AcmeCloud", aliases: ["Acme Cloud"], sourceRefs: [] }],
  evidenceIndex: [{
    evidenceId: "evidence-1",
    label: "Invoice",
    excerpt: "The invoice contains the disputed charge.",
    allowedUses: ["advisor-grounding"],
    sourceRefs: [],
  }],
  safetyConstraints: {
    prohibitedClaims: ["Do not claim approval"],
    uncertainClaims: [],
    missingJurisdictions: [],
    requiredAttribution: [],
  },
  artifactManifest: [
    "caseSnapshot",
    "callBrief",
    "playbookSnapshot",
    "speechBiasTerms",
    "evidenceIndex",
    "safetyConstraints",
  ].map((section) => ({
    artifactId: `artifact-${section}`,
    lineageKey: `plan-1:${section}`,
    artifactPath: `snapshot-1/${section}`,
    section,
    contentHash: `hash-${section}`,
    sourceRefs: [],
  })),
  sourceManifest: {
    caseRevisionId: "case-revision-1",
    caseRevisionNumber: 1,
    callPlanId: "plan-1",
    callPlanRevision: 1,
    extractionRuns: [],
    statements: [],
    kmbEntries: [],
    modelRoute: "test:model",
    compilerVersion: "test-v1",
  },
  warnings: [],
  contentHash: "snapshot-hash-1",
  compilerVersion: "test-v1",
  compiledAt: 1,
});

class BindingDatabase implements SqlDatabase {
  readonly executed: Array<{ query: string; values: unknown[] }> = [];

  async select<T>(query: string): Promise<T> {
    if (query.includes("FROM call_preparation_snapshots")) {
      return [{
        state: "ready",
        content_hash: "snapshot-hash-1",
        case_revision_id: "case-revision-1",
        call_plan_id: "plan-1",
      }] as T;
    }
    if (query.includes("call_session_preparation_bindings")) return [] as T;
    if (query.includes("next_sequence")) return [{ next_sequence: 1 }] as T;
    return [] as T;
  }

  async execute(query: string, values: unknown[] = []) {
    this.executed.push({ query, values });
    return { rowsAffected: 1 };
  }
}

test("Task 1H creates least-privilege runtime projections", () => {
  const prepared = createPreparedRuntimePreparation({
    callSessionId: "call-1",
    snapshot: bundle(),
    boundAt: 2,
  });
  assert.equal(prepared.mode, "prepared");
  if (prepared.mode !== "prepared") return;
  assert.deepEqual(prepared.stt.speechBiasTerms, ["AcmeCloud"]);
  assert.equal(JSON.stringify(prepared.stt).includes("invoice"), false);
  assert.deepEqual(prepared.artifactIdsByTarget.stt, ["artifact-speechBiasTerms"]);
  assert.ok(prepared.artifactIdsByTarget.advisor.includes("artifact-evidenceIndex"));
  assert.equal(prepared.artifactIdsByTarget.runtime.includes("artifact-evidenceIndex"), false);
});

test("Task 1H freezes one explicit preparation context per runtime owner", () => {
  const source = bundle();
  const preparation = createPreparedRuntimePreparation({ callSessionId: "call-1", snapshot: source });
  const runtime = new ActiveCallRuntime({ callSessionId: "call-1", preparation, createdAt: 2 });
  source.callBrief.objective = "Changed later";
  const frozen = runtime.snapshot().preparation;
  assert.equal(
    frozen.mode === "prepared"
      ? frozen.runtime.objective
      : "",
    "Obtain a billing correction"
  );
  assert.throws(() => new ActiveCallRuntime({
    callSessionId: "call-2",
    preparation,
  }), /another CallSession/);
});

test("Task 1H persists prepared and neutral bindings plus staged receipts", async () => {
  const database = new BindingDatabase();
  const service = new RuntimeHandoffService(database);
  const prepared = createPreparedRuntimePreparation({ callSessionId: "call-1", snapshot: bundle() });
  await service.bind(prepared);
  service.recordArtifactReceipt({
    preparation: prepared,
    target: "advisor",
    status: "visible",
    operationId: "advisor-1",
  });
  await service.drain();
  assert.ok(database.executed.some((entry) => entry.query.includes("call_session_preparation_bindings")));
  assert.equal(
    database.executed.filter((entry) => entry.query.includes("snapshot_artifact_receipts")).length,
    5
  );

  const neutralDatabase = new BindingDatabase();
  await new RuntimeHandoffService(neutralDatabase).bind(
    createNeutralRuntimePreparation({ callSessionId: "call-2" })
  );
  const binding = neutralDatabase.executed.find((entry) => entry.query.includes("call_session_preparation_bindings"));
  assert.ok(binding?.values.includes("neutral"));
  assert.equal(binding?.values.filter((value) => value === null).length, 5);
});

test("Task 1H records binding lineage and every model artifact stage", () => {
  const hook = readFileSync("src/hooks/useCallingAssistant.ts", "utf8");
  const operations = readFileSync("src/lib/calling/model-operations.ts", "utf8");
  assert.match(hook, /preparation-binding/);
  assert.match(hook, /speechBiasPrompt/);
  for (const stage of ["selected", "dispatched", "provider-returned", "commit-authorized", "visible"]) {
    assert.match(operations, new RegExp(`\\"${stage}\\"`));
  }
});
