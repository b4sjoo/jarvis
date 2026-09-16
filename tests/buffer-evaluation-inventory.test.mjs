import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRows, readIngressSource, runBufferAudit, selectBlindCases } from "../scripts/audit-sentence-buffer.mjs";

function trace(id, at, text, metadata = {}) {
  const ingress = { canonicalTurnIngressTurnId: `turn-${id}`, canonicalTurnIngressSpeaker: "them",
    canonicalTurnIngressEnteredAt: at, canonicalTurnIngressSessionId: "meeting", canonicalTurnIngressRuntimeEpoch: 1 };
  return { id, metadata: { ...ingress, ...metadata },
    steps: [{ name: "Canonical turn ingress admitted", startedAt: at, metadata: ingress }],
    outputs: [{ label: "display transcript final", recordedAt: at - 1, value: text,
      metadata: { displayTranscriptUtteranceId: ingress.canonicalTurnIngressTurnId, displayTranscriptSemanticCommitAuthorized: true } }] };
}

test("BE2 bounded blind sampling includes buffered and bypass cases without semantic cherry-picking", () => {
  const cases = Array.from({ length: 100 }, (_, i) => ({ id: `case-${i}`,
    first: { text: `text ${i}`, episodeId: i < 50 ? `buffer-${i}` : `bypass:${i}` } }));
  const sample = selectBlindCases(cases);
  assert.equal(sample.length, 40);
  assert.equal(sample.filter((item) => item.first.episodeId.startsWith("bypass:")).length, 20);
  assert.deepEqual(selectBlindCases([...cases].reverse()), sample);
});

test("BE1 selects the text known at ingress and never a later corrected display revision", () => {
  const value = trace("1", 100, "Original input");
  value.outputs.push({ ...value.outputs[0], value: "Future corrected input", recordedAt: 200 });
  assert.equal(readIngressSource(value).text, "Original input");
  assert.equal(readIngressSource({ ...value, steps: [] }), undefined);
  assert.deepEqual(readIngressSource({ ...value, outputs: [] }).evidenceGaps, ["exact-at-ingress-text-unavailable"]);
});

test("BE2 episode dedup preserves a separate future review stage", () => {
  const rows = [
    { ...readIngressSource(trace("1", 100, "First and", { sentenceBufferOperationId: "episode" })), folder: "session-a" },
    { ...readIngressSource(trace("2", 200, "second?", { sentenceBufferOperationId: "episode", sentenceBufferOperationRole: "terminal", sentenceBufferOutcome: "merged", sentenceBufferAddedLatencyMs: 100 })), folder: "session-a" },
  ];
  const result = auditRows(rows, { mergeSentenceFragments: (parts) => parts.join(" "),
    decideSentenceCompletion: () => ({ disposition: "buffer", reason: "fixture", evidence: [] }) });
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].first.text, "First and");
  assert.equal(result.cases[0].priorContext.length, 0);
  assert.equal(result.cases[0].continuation[0].text, "second?");
  assert.equal(result.cases[0].waitMs, 100);
  assert.equal(result.cases[0].humanReview.status, "unconfirmed");
});

test("BE3 generates a model-free frozen review pack outside untouched recordings", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-buffer-audit-"));
  const recording = join(dir, "recordings", "session-fixture");
  mkdirSync(join(recording, "traces"), { recursive: true });
  writeFileSync(join(recording, "manifest.json"), JSON.stringify({ scriptedValidation: true, status: "stopped", build: { gitCommit: "fixture" } }));
  const raw = JSON.stringify({ trace: trace("1", 100, "Can you explain...") });
  writeFileSync(join(recording, "traces", "one.json"), raw);
  const output = join(dir, "audit");
  const summary = runBufferAudit({ recordingsRoot: join(dir, "recordings"), outputDir: output, sessions: ["session-fixture"] });
  assert.equal(summary.sourceCount, 1);
  assert.equal(summary.providerCalls, 0);
  assert.equal(summary.precision, null);
  assert.equal(summary.confirmedSemanticLabels, 0);
  assert.equal(summary.sessions[0].declaredCollection, "scripted");
  assert.equal(readFileSync(join(recording, "traces", "one.json"), "utf8"), raw);
  assert.match(readFileSync(join(output, "blind-stage1.md"), "utf8"), /unconfirmed/);
  assert.throws(() => runBufferAudit({ recordingsRoot: join(dir, "recordings"), outputDir: recording, sessions: ["session-fixture"] }), /outside original recordings/);
  assert.throws(() => runBufferAudit({ recordingsRoot: join(dir, "recordings"), outputDir: output, sessions: ["session-fixture"] }), /EEXIST/);
});
