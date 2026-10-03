import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { normalizeRuntimeAdjudicationAuthorityLabel } from "../src/lib/meeting/runtime-adjudication-authority.js";
import { buildCompactTraceSummary } from "../src/lib/meeting/session-recording.js";
import { normalizeCanonicalQuestionType } from "../src/lib/meeting/task-taxonomy.js";
import type { MeetingTrace } from "../src/lib/meeting/types.js";
import { buildSemanticTaxonomyReflectionReport } from "../scripts/lib/semantic-taxonomy-reflection.js";
import { runSemanticScheduling } from "./helpers/semantic-observation-hook.js";

// Task 168 (PC C1): the inert Semantic Type Rescue surface is retired. The observation keeps running.
// These tests execute the hook's own Advisor expressions and record statement, the real observer
// callbacks and shadow formatter, and the real recording and reflection readers. The baseline rows
// were exported by running the pre-retirement build on the same inputs.
const source = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);

type EvidenceState = "absent" | "session-mismatch" | "epoch-mismatch" | "non-live-source" | "current";
interface BaselineRow {
  evidence: EvidenceState;
  lexicalType: string | null;
  questionType: unknown;
  semanticTaxonomyEvidenceCurrent: boolean;
  taxonomyHybridEffectiveType: string;
  recordedDecisions: number;
}
const baseline = JSON.parse(
  readFileSync("tests/fixtures/semantic-rescue-retirement-head-baseline.json", "utf8")
) as { variantsPerRow: number; advisorRows: BaselineRow[] };

// Real calibrated prototype vectors: the production scorer accepts them, so the observer produces a
// real hybrid comparison instead of the zero-vector "semantic-rejected" default.
const prototypeVectors = JSON.parse(
  readFileSync("model-manifests/semantic-taxonomy-prototype-vectors.v1.json", "utf8")
) as { vectors: Array<{ id: string; vector: number[] }> };

function prototypeVector(id: string) {
  const record = prototypeVectors.vectors.find((entry) => entry.id === id);
  assert.ok(record, `prototype vector must exist: ${id}`);
  return record.vector;
}

function baselineRow(evidence: EvidenceState, lexicalType: string | null, questionType: unknown) {
  const row = baseline.advisorRows.find(
    (candidate) =>
      candidate.evidence === evidence &&
      candidate.lexicalType === lexicalType &&
      candidate.questionType === questionType
  );
  assert.ok(row, `baseline row must exist: ${evidence}/${lexicalType}/${String(questionType)}`);
  return row;
}

// The four Advisor-side keys the retired surface wrote next to the two retained ones.
function preRetirementAdvisorKeys(parentMutationBlocked: boolean) {
  return {
    semanticTaxonomyMode: "shadow",
    taxonomySemanticEnforcementReason: "semantic-taxonomy-shadow-mode",
    taxonomySemanticParentMutationBlocked: parentMutationBlocked,
    taxonomySemanticRescueApplied: false,
  };
}

function findNode(predicate: (node: ts.Node) => boolean, label: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `production node must exist: ${label}`);
  return found;
}

function declaration(name: string) {
  return findNode(
    (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name,
    name
  ) as ts.VariableDeclaration;
}

function run(code: string, context: vm.Context) {
  return vm.runInContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context
  );
}

const ADVISOR_DECLARATIONS = [
  "semanticEvidenceTurnId",
  "semanticEvidence",
  "semanticEvidenceIsCurrent",
  "semanticEvidenceLexicalType",
  "advisorDeterministicQuestionType",
  "semanticEvidenceTraceMetadata",
];
const recordStatement = findNode(
  (node) =>
    ts.isIfStatement(node) &&
    node.expression.getText(ast) === "semanticEvidenceIsCurrent && semanticEvidence",
  "Advisor semantic decision record"
);

// Runs the Advisor's semantic-evidence declarations and its record statement as written in the hook.
// Neither settings nor a rescue decision is bound: reading either would throw.
function advise(input: {
  entry?: Record<string, unknown>;
  jobSource?: string;
  sessionId?: string;
  runtimeEpoch?: number;
  questionType: unknown;
}) {
  const recorded: Array<{ traceId: string; taskId?: string; metadata: Record<string, unknown> }> = [];
  const globals: Record<string, unknown> = {
    Boolean,
    advisorJob: {
      triggerTurnId: "turn",
      source: input.jobSource ?? "live-turn",
      expectedSessionId: input.sessionId ?? "session",
      runtimeCommitToken: { runtimeEpoch: input.runtimeEpoch ?? 7 },
    },
    latestTurn: undefined,
    semanticTaxonomyEvidenceByTurnRef: {
      current: new Map(input.entry ? [["turn", input.entry]] : []),
    },
    correctedAdvisorTaskSignals: { questionType: input.questionType },
    normalizeCanonicalQuestionType,
    promptContext: { activeMeetingTask: { id: "task" } },
    traceId: "trace",
    sessionRecordingManagerRef: {
      current: {
        recordSemanticTaxonomyDecision: (value: (typeof recorded)[number]) => recorded.push(value),
      },
    },
  };
  const context = vm.createContext(globals);
  for (const name of ADVISOR_DECLARATIONS) {
    globals[name] = run(`(${declaration(name).initializer!.getText(ast)})`, context);
  }
  run(recordStatement.getText(ast), context);
  return JSON.parse(
    JSON.stringify({ metadata: globals.semanticEvidenceTraceMetadata, recorded })
  ) as { metadata: Record<string, unknown>; recorded: typeof recorded };
}

function baselineEntry(row: BaselineRow): Record<string, unknown> | undefined {
  if (row.evidence === "absent") return undefined;
  return {
    turnId: "turn",
    sessionId: row.evidence === "session-mismatch" ? "other-session" : "session",
    runtimeEpoch: row.evidence === "epoch-mismatch" ? 6 : 7,
    lexical: { type: row.lexicalType ?? undefined },
    metadata: { semanticTaxonomyTurnId: "turn" },
  };
}

function compactSemanticSummary(metadata: Record<string, unknown>, kind: "voice" | "screen" = "voice") {
  return buildCompactTraceSummary({
    sessionId: "session",
    trigger: "manual",
    traceExportPath: "trace.json",
    summaryPath: "summary.json",
    trace: {
      id: "trace", kind, status: "success", startedAt: 1, endedAt: 2,
      steps: [], inputs: [], outputs: [], metadata,
    } as unknown as MeetingTrace,
  });
}

test("168-C1 Advisor trace metadata keeps both retained keys at their pre-retirement values and writes no rescue key", () => {
  assert.equal(baseline.variantsPerRow, 16);
  assert.equal(baseline.advisorRows.length, 48);
  assert.deepEqual(
    [...new Set(baseline.advisorRows.map((row) => row.evidence))],
    ["absent", "session-mismatch", "epoch-mismatch", "non-live-source", "current"]
  );
  for (const row of baseline.advisorRows) {
    const advised = advise({
      entry: baselineEntry(row),
      jobSource: row.evidence === "non-live-source" ? "regenerate" : "live-turn",
      questionType: row.questionType,
    });
    // Exact equality: the mode label and the three rescue-only keys are not written any more.
    assert.deepEqual(
      advised.metadata,
      {
        semanticTaxonomyEvidenceCurrent: row.semanticTaxonomyEvidenceCurrent,
        taxonomyHybridEffectiveType: row.taxonomyHybridEffectiveType,
      },
      JSON.stringify(row)
    );
    assert.equal(advised.recorded.length, row.recordedDecisions, JSON.stringify(row));
  }
});

test("168-C1 the same object reaches the Advisor trace metadata, the intent-gate step and the recorded decision", () => {
  const execution = declaration("executionMetadata").initializer;
  assert.ok(execution && ts.isObjectLiteralExpression(execution));
  assert.equal(
    execution.properties.filter(
      (property) =>
        ts.isSpreadAssignment(property) &&
        property.expression.getText(ast) === "semanticEvidenceTraceMetadata"
    ).length,
    1
  );
  const advisorBody = source.slice(
    source.indexOf("const semanticEvidenceTraceMetadata = {"),
    source.indexOf("if (!executionAuthorization.authorized) {", source.indexOf("const semanticEvidenceTraceMetadata = {"))
  );
  assert.match(advisorBody, /traceStoreRef\.current\.updateMetadata\(traceId, executionMetadata\);/);
  assert.match(advisorBody, /"Advisor response-intent gate",\s+executionMetadata/);
  assert.match(recordStatement.getText(ast), /\.\.\.semanticEvidence\.metadata,\s+\.\.\.semanticEvidenceTraceMetadata,/);
});

test("168-C1 real observer, Advisor record and readers give the pre-retirement values without the retired label", async () => {
  for (const input of [{ embeddingStatus: "success", parent: true }, { eligible: false }]) {
    const observed = await runSemanticScheduling(source, input);
    const traceUpdates: Array<Record<string, unknown>> = observed.events
      .filter((event: unknown[]) => event[0] === "metadata")
      .map((event: unknown[]) => event[2]);
    const observerDecisions: Array<{ taskId?: string; metadata: Record<string, unknown> }> = observed.events
      .filter((event: unknown[]) => event[0] === "taxonomy")
      .map((event: unknown[]) => event[1]);
    assert.equal(traceUpdates.length, input.eligible === false ? 1 : 2);
    assert.equal(observerDecisions.length, 1);
    for (const metadata of [...traceUpdates, ...observerDecisions.map((decision) => decision.metadata)]) {
      assert.equal("semanticTaxonomyMode" in metadata, false);
      assert.equal(metadata.taxonomySemanticRescueApplied, false);
      assert.equal(metadata.taxonomySemanticBehaviorMutationBlocked, true);
      assert.equal(metadata.taxonomyHybridEffectiveType, metadata.taxonomyKeywordType);
    }

    assert.equal(observed.evidence.length, 1);
    const [turnId, entry] = observed.evidence[0] as [string, Record<string, any>];
    assert.equal(turnId, "t");
    // The comparison result stays in the recorded metadata; the in-memory carrier no longer copies it.
    assert.deepEqual(Object.keys(entry).sort(), ["lexical", "metadata", "runtimeEpoch", "sessionId", "turnId"]);
    assert.deepEqual(entry.metadata, traceUpdates[traceUpdates.length - 1]);
    const lexicalType = entry.lexical.type ?? "unknown";
    const observerTraceMetadata = Object.assign({}, ...traceUpdates);

    for (const questionType of ["unknown", "general-system-design"]) {
      const expectedType = questionType === "unknown" ? lexicalType : questionType;
      const advised = advise({ entry, sessionId: entry.sessionId, runtimeEpoch: entry.runtimeEpoch, questionType });
      assert.deepEqual(advised.metadata, {
        semanticTaxonomyEvidenceCurrent: true,
        taxonomyHybridEffectiveType: expectedType,
      });
      assert.deepEqual(advised.recorded, [{
        traceId: "trace",
        taskId: "task",
        metadata: { ...entry.metadata, semanticTaxonomyEvidenceCurrent: true, taxonomyHybridEffectiveType: expectedType },
      }]);
      const recordedMetadata: Record<string, unknown> = { ...advised.recorded[0]!.metadata };
      assert.equal(recordedMetadata.taxonomySemanticRescueApplied, false);
      assert.equal(recordedMetadata.taxonomySemanticBehaviorMutationBlocked, true);

      // Offline reflection reader over the decisions a new recording would hold.
      const report = buildSemanticTaxonomyReflectionReport({
        decisions: [
          ...observerDecisions.map((decision, index) => ({
            recordedAt: 10 + index, sessionId: "s", traceId: "trace", taskId: decision.taskId, metadata: decision.metadata,
          })),
          { recordedAt: 100, sessionId: "s", traceId: "trace", taskId: "task", metadata: recordedMetadata },
        ],
        evaluations: [{
          id: "eval", questionId: "question", traceIds: ["trace"], questionType: "general-system-design",
          classification: { verdict: "ok" }, updatedAt: 200,
        }],
      });
      assert.equal(report.rows.length, 1);
      const row = report.rows[0]!;
      assert.equal(row.lexicalType, lexicalType);
      assert.equal(row.effectiveType, expectedType);
      assert.equal(row.labelOutcome, expectedType === "general-system-design" ? "confirmed" : "corrected");
      assert.equal(row.rescueApplied, false);
      assert.equal(row.wouldRescue, false);
      assert.equal(row.correctionAfterRescue, false);
      assert.equal(report.metrics.rescueApplied, 0);
      // The retired keys read as absent for new recordings.
      assert.equal(row.mode, undefined);
      assert.equal(row.enforcementReason, undefined);
      assert.equal(row.parentMutationBlocked, false);

      // Compact trace summary reader, in both orders the two trace writers can land.
      const advisorLast = compactSemanticSummary({ ...observerTraceMetadata, ...advised.metadata }).semanticTaxonomy;
      const observerLast = compactSemanticSummary({ ...advised.metadata, ...observerTraceMetadata }).semanticTaxonomy;
      assert.ok(advisorLast && observerLast);
      assert.equal(advisorLast.hybridEffectiveType, expectedType);
      assert.equal(observerLast.hybridEffectiveType, lexicalType);
      for (const summary of [advisorLast, observerLast]) {
        assert.equal(summary.mode, undefined);
        assert.equal(summary.keywordType, lexicalType);
        assert.equal(summary.rescueApplied, false);
        assert.equal(summary.wouldRescue, false);
        assert.equal(summary.embeddingStatus, input.eligible === false ? "not-requested" : "success");
      }
    }
  }
});

test("168-C1 a real would-rescue observation stays a recorded comparison and never becomes the Advisor Type", async () => {
  const systemDesign = prototypeVector("semantic-general-system-design-positive-distributed-design");
  for (const parent of [false, true]) {
    const observed = await runSemanticScheduling(source, {
      parent,
      embeddings: parent ? [systemDesign, systemDesign] : [systemDesign],
    });
    const stages: string[] = observed.events.map((event: unknown[]) => event[0]);
    // Formal Type and Relation were scheduled before the embedding and their handles are returned as they are.
    assert.ok(stages.indexOf("type") < stages.indexOf("relation"));
    assert.ok(stages.indexOf("relation") < stages.indexOf("embed"));
    assert.equal(stages.filter((stage) => stage === "type" || stage === "relation").length, 2);
    const embedRequest = observed.events.find((event: unknown[]) => event[0] === "embed") as [string, { texts: string[] }, { consumer: string }];
    assert.equal(embedRequest[1].texts.length, parent ? 2 : 1);
    assert.equal(embedRequest[2].consumer, "interviewer-intent");

    const traceUpdates: Array<Record<string, unknown>> = observed.events
      .filter((event: unknown[]) => event[0] === "metadata")
      .map((event: unknown[]) => event[2]);
    const observerDecisions: Array<{ taskId?: string; metadata: Record<string, unknown> }> = observed.events
      .filter((event: unknown[]) => event[0] === "taxonomy")
      .map((event: unknown[]) => event[1]);
    assert.equal(traceUpdates.length, 2);
    assert.equal(observerDecisions.length, 1);
    const completed = traceUpdates[1]!;
    assert.deepEqual(observerDecisions[0]!.metadata, completed);
    // The comparison the scorer really produced for a lexical-unknown question.
    assert.deepEqual(
      {
        keywordType: completed.taxonomyKeywordType,
        embeddingStatus: completed.taxonomySemanticEmbeddingStatus,
        candidateType: completed.taxonomySemanticCandidateType,
        accepted: completed.taxonomySemanticAccepted,
        outcome: completed.taxonomyHybridOutcome,
        recommendedType: completed.taxonomyHybridRecommendedType,
        wouldRescue: completed.taxonomyHybridWouldRescue,
        effectiveType: completed.taxonomyHybridEffectiveType,
        rescueApplied: completed.taxonomySemanticRescueApplied,
        behaviorMutationBlocked: completed.taxonomySemanticBehaviorMutationBlocked,
      },
      {
        keywordType: "unknown", embeddingStatus: "success", candidateType: "general-system-design", accepted: true,
        outcome: "semantic-would-rescue", recommendedType: "general-system-design", wouldRescue: true,
        effectiveType: "unknown", rescueApplied: false, behaviorMutationBlocked: true,
      }
    );
    for (const metadata of traceUpdates) {
      for (const retired of ["semanticTaxonomyMode", "taxonomySemanticEnforcementReason", "taxonomySemanticParentMutationBlocked"]) {
        assert.equal(retired in metadata, false, retired);
      }
    }

    assert.equal(observed.evidence.length, 1);
    const entry = observed.evidence[0]![1] as Record<string, any>;
    assert.deepEqual(Object.keys(entry).sort(), ["lexical", "metadata", "runtimeEpoch", "sessionId", "turnId"]);
    assert.deepEqual(entry.metadata, completed);
    const lexicalType: string | null = entry.lexical.type ?? null;
    const observerTraceMetadata = Object.assign({}, ...traceUpdates);

    for (const questionType of ["unknown", "coding"]) {
      const before = baselineRow("current", lexicalType, questionType);
      // Pre-retirement value: the deterministic Type when it is known, else the lexical Type. Never the recommendation.
      const expectedType = questionType === "unknown" ? "unknown" : "coding";
      assert.equal(before.taxonomyHybridEffectiveType, expectedType);
      const advised = advise({ entry, sessionId: entry.sessionId, runtimeEpoch: entry.runtimeEpoch, questionType });
      assert.deepEqual(advised.metadata, {
        semanticTaxonomyEvidenceCurrent: before.semanticTaxonomyEvidenceCurrent,
        taxonomyHybridEffectiveType: before.taxonomyHybridEffectiveType,
      });
      assert.equal(advised.recorded.length, before.recordedDecisions);
      assert.deepEqual(advised.recorded[0]!.metadata, { ...completed, ...advised.metadata });
      const recordedMetadata: Record<string, unknown> = { ...advised.recorded[0]!.metadata };
      assert.equal(recordedMetadata.taxonomyHybridWouldRescue, true);
      assert.equal(recordedMetadata.taxonomyHybridRecommendedType, "general-system-design");
      assert.equal(recordedMetadata.taxonomySemanticRescueApplied, false);

      const reflect = (advisorMetadata: Record<string, unknown>) =>
        buildSemanticTaxonomyReflectionReport({
          decisions: [
            { recordedAt: 10, sessionId: "s", traceId: "trace", taskId: observerDecisions[0]!.taskId, metadata: completed },
            { recordedAt: 100, sessionId: "s", traceId: "trace", taskId: "task", metadata: advisorMetadata },
          ],
          evaluations: [{
            id: "eval", questionId: "question", traceIds: ["trace"], questionType: "general-system-design",
            classification: { verdict: "ok" }, updatedAt: 200,
          }],
        });
      const report = reflect(recordedMetadata);
      assert.equal(report.rows.length, 1);
      const row = report.rows[0]!;
      assert.equal(row.lexicalType, "unknown");
      assert.equal(row.semanticCandidateType, "general-system-design");
      assert.equal(row.hybridOutcome, "semantic-would-rescue");
      assert.equal(row.hybridRecommendedType, "general-system-design");
      assert.equal(row.wouldRescue, true);
      assert.equal(row.rescueApplied, false);
      assert.equal(row.effectiveType, expectedType);
      // The human label is the recommended Type, so the unrescued effective Type reads as corrected.
      assert.equal(row.labelOutcome, "corrected");
      assert.equal(row.correctionAfterRescue, false);
      assert.equal(report.metrics.wouldRescue, 1);
      assert.equal(report.metrics.rescueApplied, 0);

      // Evaluation discontinuity (recorded, not hidden): the build before this retirement also wrote
      // taxonomySemanticParentMutationBlocked=true for a current would-rescue comparison. The key is no
      // longer written, so the unchanged reader reports false / 0 for new recordings. The would-rescue
      // flag and the recommended Type above still carry the same information.
      assert.equal(row.mode, undefined);
      assert.equal(row.enforcementReason, undefined);
      assert.equal(row.parentMutationBlocked, false);
      assert.equal(report.metrics.parentMutationBlocked, 0);
      const preRetirement = reflect({ ...recordedMetadata, ...preRetirementAdvisorKeys(true) });
      assert.equal(preRetirement.rows[0]!.parentMutationBlocked, true);
      assert.equal(preRetirement.metrics.parentMutationBlocked, 1);
      // Every other reflection value is the same for both shapes.
      const { mode: _mode, enforcementReason: _reason, parentMutationBlocked: _blocked, ...rowNow } = row;
      const { mode: _oldMode, enforcementReason: _oldReason, parentMutationBlocked: _oldBlocked, ...rowBefore } = preRetirement.rows[0]!;
      assert.deepEqual(rowNow, rowBefore);
      assert.deepEqual(
        { ...report.metrics, parentMutationBlocked: 1 },
        preRetirement.metrics
      );

      // Compact trace summary in both orders the two trace writers can land.
      const advisorLast = compactSemanticSummary({ ...observerTraceMetadata, ...advised.metadata }).semanticTaxonomy;
      const observerLast = compactSemanticSummary({ ...advised.metadata, ...observerTraceMetadata }).semanticTaxonomy;
      assert.ok(advisorLast && observerLast);
      assert.equal(advisorLast.hybridEffectiveType, expectedType);
      assert.equal(observerLast.hybridEffectiveType, "unknown");
      for (const summary of [advisorLast, observerLast]) {
        assert.equal(summary.mode, undefined);
        assert.equal(summary.keywordType, "unknown");
        assert.equal(summary.semanticCandidateType, "general-system-design");
        assert.equal(summary.hybridOutcome, "semantic-would-rescue");
        assert.equal(summary.wouldRescue, true);
        assert.equal(summary.rescueApplied, false);
        assert.equal(summary.embeddingStatus, "success");
      }
    }
  }
});

test("168-C1 a new Advisor-only trace keeps the effective Type in trace metadata and in its compact semantic block", () => {
  // Advisor traces that carry no observer metadata of their own: Screen and manual-action traces, and
  // voice traces whose turn evidence is absent, from another session or epoch, or not a live turn.
  const staleEntry = {
    turnId: "turn", sessionId: "other-session", runtimeEpoch: 7,
    lexical: { type: "behavioral" }, metadata: { semanticTaxonomyTurnId: "turn" },
  };
  const liveEntry = { ...staleEntry, sessionId: "session" };
  const cases: Array<{ name: string; kind: "voice" | "screen"; advised: ReturnType<typeof advise> }> = [
    { name: "no evidence, screen", kind: "screen", advised: advise({ questionType: "coding" }) },
    { name: "no evidence, voice", kind: "voice", advised: advise({ questionType: "coding" }) },
    { name: "evidence from another session", kind: "voice", advised: advise({ entry: staleEntry, questionType: "coding" }) },
    { name: "not a live turn", kind: "voice", advised: advise({ entry: liveEntry, jobSource: "regenerate", questionType: "coding" }) },
  ];
  for (const { name, kind, advised } of cases) {
    // The full trace export keeps the retained key at its pre-retirement value.
    assert.deepEqual(advised.metadata, { semanticTaxonomyEvidenceCurrent: false, taxonomyHybridEffectiveType: "coding" }, name);
    assert.deepEqual(advised.recorded, [], name);

    // The compact block is kept for a trace that carries only the effective Type, so a reader that has
    // only compact summaries still gets hybridEffectiveType. The retired mode label and the Advisor-side
    // rescue flag are not part of it any more.
    const now = compactSemanticSummary(advised.metadata, kind);
    assert.deepEqual(JSON.parse(JSON.stringify(now.semanticTaxonomy)), { hybridEffectiveType: "coding" }, name);
    const before = compactSemanticSummary({ ...advised.metadata, ...preRetirementAdvisorKeys(false) }, kind);
    assert.deepEqual(
      JSON.parse(JSON.stringify(before.semanticTaxonomy)),
      { mode: "shadow", hybridEffectiveType: "coding", rescueApplied: false },
      name
    );
    // Nothing else in the compact summary depends on the retired keys (recordedAt is the wall clock).
    assert.deepEqual(
      { ...before, semanticTaxonomy: undefined, recordedAt: 0 },
      { ...now, semanticTaxonomy: undefined, recordedAt: 0 },
      name
    );
  }
});

test("168-C1 records written by the retired surface still decode in the recording and reflection readers", () => {
  // Shape written by earlier builds, including values no current code can produce.
  const historical = {
    semanticTaxonomyShadowVersion: "semantic-taxonomy-shadow-v1",
    semanticTaxonomyMode: "enforcement",
    semanticTaxonomySessionId: "session_old",
    semanticTaxonomyTurnId: "turn_old",
    semanticTaxonomyEvidenceCurrent: true,
    taxonomyKeywordType: "unknown",
    taxonomySemanticCandidateType: "coding",
    taxonomySemanticEmbeddingStatus: "success",
    taxonomyHybridOutcome: "semantic-would-rescue",
    taxonomyHybridRecommendedType: "coding",
    taxonomyHybridWouldRescue: true,
    taxonomyHybridEffectiveType: "coding",
    taxonomySemanticRescueApplied: true,
    taxonomySemanticEnforcementReason: "semantic-rescued-lexical-unknown-without-parent",
    taxonomySemanticParentMutationBlocked: true,
    taxonomySemanticBehaviorMutationBlocked: true,
    taskBoundaryAuthoritySource: "semantic-unknown-rescue",
  };

  const summary = compactSemanticSummary(historical);
  assert.deepEqual(
    {
      mode: summary.semanticTaxonomy?.mode,
      keywordType: summary.semanticTaxonomy?.keywordType,
      hybridOutcome: summary.semanticTaxonomy?.hybridOutcome,
      hybridEffectiveType: summary.semanticTaxonomy?.hybridEffectiveType,
      wouldRescue: summary.semanticTaxonomy?.wouldRescue,
      rescueApplied: summary.semanticTaxonomy?.rescueApplied,
    },
    {
      mode: "enforcement", keywordType: "unknown", hybridOutcome: "semantic-would-rescue",
      hybridEffectiveType: "coding", wouldRescue: true, rescueApplied: true,
    }
  );
  assert.equal(summary.taskBoundary?.authoritySource, "semantic-unknown-rescue");
  assert.equal(normalizeRuntimeAdjudicationAuthorityLabel("semantic-unknown-rescue"), "semantic-unknown-rescue");

  // An old Advisor-only trace carried the mode label and no embedding keys.
  const advisorOnly = compactSemanticSummary({
    semanticTaxonomyMode: "shadow",
    semanticTaxonomyEvidenceCurrent: false,
    taxonomySemanticEnforcementReason: "semantic-taxonomy-shadow-mode",
    taxonomySemanticParentMutationBlocked: false,
    taxonomySemanticRescueApplied: false,
    taxonomyHybridEffectiveType: "coding",
  }, "screen").semanticTaxonomy;
  assert.equal(advisorOnly?.mode, "shadow");
  assert.equal(advisorOnly?.hybridEffectiveType, "coding");
  assert.equal(advisorOnly?.rescueApplied, false);

  const report = buildSemanticTaxonomyReflectionReport({
    decisions: [{ recordedAt: 10, sessionId: "session_old", traceId: "trace_old", metadata: historical }],
    evaluations: [{
      id: "eval_old", questionId: "question_old", traceIds: ["trace_old"], questionType: "coding",
      classification: { verdict: "ok" }, updatedAt: 20,
    }],
  });
  assert.equal(report.rows.length, 1);
  const row = report.rows[0]!;
  assert.equal(row.mode, "enforcement");
  assert.equal(row.effectiveType, "coding");
  assert.equal(row.wouldRescue, true);
  assert.equal(row.rescueApplied, true);
  assert.equal(row.rescueCorrect, true);
  assert.equal(row.parentMutationBlocked, true);
  assert.equal(row.enforcementReason, "semantic-rescued-lexical-unknown-without-parent");
  assert.equal(report.metrics.rescueApplied, 1);
  assert.equal(report.metrics.parentMutationBlocked, 1);
});

test("168-C1 no rescue decision, mode setting, setter or control remains in the live source", () => {
  const retired = /decideSemanticTaxonomyUnknownRescue|SemanticTaxonomyUnknownRescueDecision|semanticUnknownRescueDecision|semanticAdvisorTaskSignals|setSemanticTaxonomyMode|semanticTaxonomyModeRef|isSemanticTaxonomyMode|onSemanticTaxonomyModeChange|SemanticTaxonomyMode\b|settings\.semanticTaxonomyMode|semantic-unknown-rescue|Semantic Type Rescue|taxonomySemanticEnforcementReason|taxonomySemanticParentMutationBlocked/;
  for (const file of [
    "src/hooks/useMeetingAssistant.ts",
    "src/lib/meeting/semantic-taxonomy-shadow.ts",
    "src/lib/meeting/types.ts",
    "src/lib/meeting/task-boundary-transaction.ts",
    "src/lib/meeting/current-question-settlement.ts",
    "src/pages/app/components/meeting/index.tsx",
  ]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), retired, file);
  }
  // The only live mention of the stored key is the historical recording decoder.
  assert.doesNotMatch(source, /semanticTaxonomyMode/);
  assert.match(readFileSync("src/lib/meeting/session-recording.ts", "utf8"), /readFirstString\(metadataSources, "semanticTaxonomyMode"\)/);
});

test("168-C1 the ledger entry forbids only the retired surface, never a key a retained reader decodes", () => {
  const ledger = JSON.parse(readFileSync("architecture/deletion-ledger.json", "utf8")) as {
    entries: Array<{
      id: string; ownerTaskId: number; verdict: string; status: string;
      persistedDataImpact: string; forbiddenPatterns?: string[];
    }>;
  };
  const entries = ledger.entries.filter((entry) => entry.id === "semantic-type-rescue-surface");
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.deepEqual(
    { ownerTaskId: entry.ownerTaskId, verdict: entry.verdict, status: entry.status, persistedDataImpact: entry.persistedDataImpact },
    { ownerTaskId: 168, verdict: "delete", status: "deleted", persistedDataImpact: "settings" }
  );
  const patterns = entry.forbiddenPatterns ?? [];
  assert.ok(patterns.length > 0);

  // Readers of historical recordings that stay. The gate matches by plain substring, so a pattern
  // that names a key one of them decodes would forbid the decoder itself.
  const retainedReaders = [
    "src/lib/meeting/session-recording.ts",
    "scripts/lib/semantic-taxonomy-reflection.ts",
    "scripts/reflect-session-longitudinal-evaluation.ts",
    "scripts/lib/session-longitudinal-evaluation.ts",
    "scripts/lib/taxonomy-adjudication-reflection.ts",
  ].map((file) => ({ file, text: readFileSync(file, "utf8") }));
  for (const pattern of patterns) {
    for (const { file, text } of retainedReaders) {
      assert.equal(text.includes(pattern), false, `${file} still decodes "${pattern}"`);
    }
  }
  // The keys those readers decode today, including the two rescue-only Advisor keys of old recordings.
  const decoded = [
    "semanticTaxonomyMode", "taxonomySemanticRescueApplied", "taxonomyHybridEffectiveType",
    "taxonomySemanticEnforcementReason", "taxonomySemanticParentMutationBlocked",
  ];
  const reflectionReader = retainedReaders[1]!.text;
  for (const key of decoded) {
    assert.ok(reflectionReader.includes(`"${key}"`), `the reflection reader decodes ${key}`);
    assert.equal(patterns.some((pattern) => key.includes(pattern)), false, `${key} must stay decodable`);
  }
});
