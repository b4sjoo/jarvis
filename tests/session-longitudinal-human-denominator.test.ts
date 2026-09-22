import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHumanGroundTruthEventV2,
  deriveHumanEvaluationProjectionV2,
  type HumanGroundTruthEventV2,
} from "../src/lib/meeting/human-ground-truth-v2.js";
import {
  buildSessionLongitudinalEvaluationReport,
  renderSessionLongitudinalEvaluationMarkdown,
  type LongitudinalSessionInput,
} from "../src/lib/meeting/session-longitudinal-evaluation.js";
import { loadSessionHumanEvaluationConsumerView } from "../scripts/session-human-evaluation-v2.js";
import { projectHumanEvaluationsForLegacyConsumers } from "../src/lib/meeting/human-evaluation-v2-consumers.js";

const subject = { attemptId: "trace-a", questionId: "question-a", traceIds: ["trace-a"], sourceTurnIds: ["turn-a"] };
function event(id: string, type = "coding", options: Partial<HumanGroundTruthEventV2> = {}) {
  return { ...createHumanGroundTruthEventV2({ eventId: id, sessionId: "meeting-a", subject,
    source: "explicit-ui", sourceTraceId: "trace-a", now: 10,
    fact: { kind: "expected-question-type", expectedQuestionType: type as "coding" },
  }), ...options };
}
function session(events: HumanGroundTruthEventV2[] = []): LongitudinalSessionInput {
  return {
    directory: "/recording-a", manifest: { sessionId: "recording-a" }, transcriptTurns: [],
    traceSummaries: [{ traceId: "trace-a", logicalQuestionUnitId: "question-a", questionType: "coding",
      taskRelation: "new-parent", taskMutationCommand: "create-parent", advisorExecutionAuthorized: true }],
    questionEvaluations: [],
    humanEvaluationProjectionsV2: [deriveHumanEvaluationProjectionV2({ sessionId: "meeting-a", subject, events,
      observed: { traceId: "trace-a", traceHash: "hash-a", questionType: "coding", relation: "new-parent", parentAction: "create" }, now: 20 })],
  };
}

test("3C observed-only compatibility objects are not human labels", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-3c-denominator-"));
  try {
    await mkdir(path.join(directory, "human-evaluation"));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ status: "stopped" }));
    await writeFile(path.join(directory, "human-evaluation/projections-v2.json"), JSON.stringify({ projections: session().humanEvaluationProjectionsV2 }));
    const view = await loadSessionHumanEvaluationConsumerView(directory);
    assert.equal(view.evaluations.length, 1);
    const report = buildSessionLongitudinalEvaluationReport([{ ...session(), questionEvaluations: view.evaluations,
      humanEvaluationProjectionsV2: view.allProjections }]);
    assert.deepEqual(report.cohort.labeledTraceCoverage, { numerator: 0, denominator: 1, rate: 0 });
    assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null);
    assert.equal(report.continuityFunnel.relationAgreement.rate, null);
    assert.equal(report.evidenceGaps.unlabeledProductionTraces, 1);
    assert.match(renderSessionLongitudinalEvaluationMarkdown(report), /Human-labeled trace coverage: 0\.0% \(0\/1\)/);
    assert.equal(report.cohort.observedProjectionCount, 1);
    assert.equal(report.cohort.observedTraceCoverage.numerator, 1);
    assert.equal(report.answerQuality.usefulRate.rate, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("3C type-only confirmed fact supplies only the Type denominator", () => {
  const report = buildSessionLongitudinalEvaluationReport([session([event("type-a")])]);
  assert.deepEqual(report.cohort.labeledTraceCoverage, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual(report.typeFunnel.agreementWithHuman.runtime, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(report.continuityFunnel.relationAgreement.denominator, 0);
  assert.equal(report.continuityFunnel.parentActionAgreement.denominator, 0);
  assert.equal(report.intentFunnel.humanLabeled, 0);
  assert.equal(report.answerQuality.humanLabeled, 0);
  assert.deepEqual(report.humanEvidence[0].eventIds, ["type-a"]);
});

test("3C effective V2 supersession wins without duplicate projection coverage", () => {
  const input = session([event("old", "behavioral"), event("current", "coding", { supersedesEventId: "old" })]);
  input.humanEvaluationProjectionsV2!.push(input.humanEvaluationProjectionsV2![0]);
  const report = buildSessionLongitudinalEvaluationReport([input]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 1);
  assert.deepEqual(report.typeFunnel.agreementWithHuman.runtime, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(report.cohort.observedProjectionCount, 1);
  assert.deepEqual(report.humanEvidence[0].eventIds, ["current"]);
});

test("3C V2 conflict cannot fall back to a stale legacy label", () => {
  const input = session([event("one"), event("two", "behavioral")]);
  input.questionEvaluations = [{ id: "legacy", questionId: "question-a", traceIds: ["trace-a"],
    questionType: "coding", classification: { verdict: "ok" }, expectedRelation: "new-parent" }];
  const report = buildSessionLongitudinalEvaluationReport([input]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 0);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null);
  assert.equal(report.continuityFunnel.relationAgreement.rate, null);
  assert.equal(report.humanProjectionDiagnostics[0].conflicts.length, 1);
});

test("3C a Type conflict leaves an independently confirmed Answer dimension intact", () => {
  const answer = createHumanGroundTruthEventV2({ eventId: "answer", sessionId: "meeting-a", subject,
    source: "explicit-ui", now: 12, fact: { kind: "answer-quality", outcome: "useful", failureReasons: [], expectedContextTurnIds: [] } });
  const report = buildSessionLongitudinalEvaluationReport([session([event("one"), event("two", "behavioral"), answer])]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 1);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null);
  assert.deepEqual(report.answerQuality.usefulRate, { numerator: 1, denominator: 1, rate: 1 });
  assert.deepEqual(report.humanEvidence[0].eventIds, ["answer"]);
});

test("3C suggested, intervention-only and wrong-attempt events remain unscored", () => {
  const suggested = event("suggested", "coding", { confirmation: "suggested" });
  const intervention = createHumanGroundTruthEventV2({ eventId: "intervention", sessionId: "meeting-a", subject,
    source: "manual-type-correction", collection: "scripted-validation", now: 10,
    fact: { kind: "expected-question-type", expectedQuestionType: "coding" } });
  const wrongAttempt = event("wrong-attempt", "coding", { subject: { ...subject, attemptId: "trace-other" } });
  const wrongSession = event("wrong-session", "coding", { sessionId: "other-meeting" });
  const wrongSource = event("wrong-source");
  wrongSource.provenance.sourceTraceId = "trace-other";
  for (const candidate of [suggested, intervention, wrongAttempt, wrongSession, wrongSource]) {
    const report = buildSessionLongitudinalEvaluationReport([session([candidate])]);
    assert.equal(report.cohort.labeledTraceCoverage.numerator, 0, candidate.eventId);
    assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null, candidate.eventId);
  }
});

test("3C organic manual Correction supplies Type truth without manufacturing Answer quality", () => {
  const correction = createHumanGroundTruthEventV2({ eventId: "correction", sessionId: "meeting-a", subject,
    source: "manual-type-correction", collection: "organic", now: 10,
    fact: { kind: "expected-question-type", expectedQuestionType: "coding" } });
  const report = buildSessionLongitudinalEvaluationReport([session([correction])]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 1);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.denominator, 1);
  assert.equal(report.answerQuality.humanLabeled, 0);
});

test("3C a missing attempt remains ineligible even with confirmed facts", () => {
  const input = session([event("type-a")]);
  delete input.humanEvaluationProjectionsV2![0].subject.attemptId;
  const report = buildSessionLongitudinalEvaluationReport([input]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 0);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null);
  assert.equal(report.humanProjectionDiagnostics[0].precisionEligible, false);
});

test("3C file reader preserves excluded V2 subjects so legacy compatibility cannot restore truth", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-3c-excluded-"));
  try {
    await mkdir(path.join(directory, "human-evaluation"));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ status: "stopped" }));
    const noAttempt = { ...subject, attemptId: undefined };
    const fact = event("no-attempt", "coding", { subject: noAttempt });
    const projection = deriveHumanEvaluationProjectionV2({ sessionId: "meeting-a", subject: noAttempt, events: [fact],
      observed: session().humanEvaluationProjectionsV2![0].observed, now: 20 });
    const legacy = projectHumanEvaluationsForLegacyConsumers({ evaluations: [], projections: [projection] }).evaluations;
    await writeFile(path.join(directory, "human-evaluation/question-evaluations.json"), JSON.stringify({ evaluations: legacy }));
    await writeFile(path.join(directory, "human-evaluation/projections-v2.json"), JSON.stringify({ projections: [projection] }));
    await writeFile(path.join(directory, "human-evaluation/ground-truth-v2.jsonl"), JSON.stringify(fact) + "\n");
    const view = await loadSessionHumanEvaluationConsumerView(directory);
    assert.equal(view.projections.length, 0);
    assert.equal(view.allProjections.length, 1);
    const report = buildSessionLongitudinalEvaluationReport([{ ...session(), questionEvaluations: view.legacyOnlyEvaluations,
      humanEvaluationProjectionsV2: view.allProjections }]);
    assert.equal(report.cohort.labeledTraceCoverage.numerator, 0);
    assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null);
    assert.equal(report.cohort.observedProjectionCount, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("3C file reader excludes a matched V1 question copy with a different historical trace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-3c-v1-copy-"));
  try {
    await mkdir(path.join(directory, "human-evaluation"));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ status: "stopped" }));
    const type = event("type-a");
    const projection = session([type]).humanEvaluationProjectionsV2![0];
    const legacy = projectHumanEvaluationsForLegacyConsumers({ evaluations: [], projections: [projection] }).evaluations;
    legacy[0].traceIds = ["trace-legacy-copy"];
    await writeFile(path.join(directory, "human-evaluation/question-evaluations.json"), JSON.stringify({ evaluations: legacy }));
    await writeFile(path.join(directory, "human-evaluation/projections-v2.json"), JSON.stringify({ projections: [projection] }));
    await writeFile(path.join(directory, "human-evaluation/ground-truth-v2.jsonl"), JSON.stringify(type) + "\n");
    const view = await loadSessionHumanEvaluationConsumerView(directory);
    assert.equal(view.legacyEvaluations.length, 1);
    assert.equal(view.legacyOnlyEvaluations.length, 0);
    const input = session();
    input.traceSummaries.push({ traceId: "trace-legacy-copy", questionType: "coding" });
    const report = buildSessionLongitudinalEvaluationReport([{ ...input, questionEvaluations: view.legacyOnlyEvaluations,
      humanEvaluationProjectionsV2: view.allProjections }]);
    assert.deepEqual(report.cohort.labeledTraceCoverage, { numerator: 1, denominator: 2, rate: 0.5 });
    assert.equal(report.typeFunnel.agreementWithHuman.runtime.denominator, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("3C file reader re-arbitrates superseded truth and journal history before reporting dimensions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-3c-reader-"));
  try {
    await mkdir(path.join(directory, "human-evaluation"));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ status: "stopped" }));
    const old = event("old", "behavioral");
    const current = event("current", "coding", { supersedesEventId: "old" });
    const settlement = createHumanGroundTruthEventV2({ eventId: "settlement", sessionId: "meeting-a", subject,
      source: "explicit-ui", now: 15, fact: { kind: "expected-task-settlement", expectedQuestionType: "coding",
        expectedRelation: "new-parent", expectedParentAction: "create" } });
    const answer = createHumanGroundTruthEventV2({ eventId: "answer", sessionId: "meeting-a", subject,
      source: "explicit-ui", now: 16, fact: { kind: "answer-quality", outcome: "partial", failureReasons: [], expectedContextTurnIds: [] } });
    const stale = session([old]).humanEvaluationProjectionsV2![0];
    await writeFile(path.join(directory, "human-evaluation/projections-v2.jsonl"), [stale, stale, stale].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(path.join(directory, "human-evaluation/ground-truth-v2.jsonl"), [old, current, settlement, answer].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const view = await loadSessionHumanEvaluationConsumerView(directory);
    assert.equal(view.projections.length, 1);
    const report = buildSessionLongitudinalEvaluationReport([{ ...session(), questionEvaluations: view.legacyOnlyEvaluations,
      humanEvaluationProjectionsV2: view.allProjections }]);
    assert.equal(report.cohort.labeledTraceCoverage.numerator, 1);
    assert.equal(report.cohort.observedProjectionCount, 1);
    assert.equal(report.typeFunnel.agreementWithHuman.runtime.numerator, 1);
    assert.equal(report.continuityFunnel.relationAgreement.denominator, 1);
    assert.equal(report.continuityFunnel.parentActionAgreement.denominator, 1);
    assert.deepEqual(report.answerQuality, { humanLabeled: 1, usefulRate: { numerator: 0, denominator: 1, rate: 0 } });
    assert.deepEqual(new Set(report.humanEvidence[0].eventIds), new Set(["current", "settlement", "answer"]));
    const markdown = renderSessionLongitudinalEvaluationMarkdown(report);
    assert.match(markdown, /Human Answer quality labels: 1; useful share: 0\.0% \(0\/1\)/);
    assert.match(markdown, /not directly comparable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("3C a frozen attempt does not label every trace in its historical subject", () => {
  const input = session([event("type-a")]);
  input.traceSummaries.push({ traceId: "trace-other", questionType: "coding" });
  input.humanEvaluationProjectionsV2![0].subject.traceIds.push("trace-other");
  const report = buildSessionLongitudinalEvaluationReport([input]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 1);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.denominator, 1);
});

test("3C legacy-only explicit labels retain their dimension-specific denominator", () => {
  const input = session();
  input.humanEvaluationProjectionsV2 = [];
  input.questionEvaluations = [{ id: "legacy", questionId: "question-a", traceIds: ["trace-a"],
    questionType: "coding", classification: { verdict: "ok" } }];
  const report = buildSessionLongitudinalEvaluationReport([input]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 1);
  assert.deepEqual(report.typeFunnel.agreementWithHuman.runtime, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(report.continuityFunnel.relationAgreement.rate, null);
});

test("3C a legacy object containing only observed Type is not a semantic label", () => {
  const input = session();
  input.humanEvaluationProjectionsV2 = [];
  input.questionEvaluations = [{ id: "legacy-observed", questionId: "question-a", traceIds: ["trace-a"], questionType: "coding" }];
  const report = buildSessionLongitudinalEvaluationReport([input]);
  assert.equal(report.cohort.labeledTraceCoverage.numerator, 0);
  assert.equal(report.typeFunnel.agreementWithHuman.runtime.rate, null);
});
