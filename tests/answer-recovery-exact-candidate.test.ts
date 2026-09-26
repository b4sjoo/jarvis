import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ANSWER_RESOLUTION_PROMPT_VERSION,
  EVIDENCE_REQUIREMENT_PROMPT_VERSION,
  buildAnswerRecoveryAdjudicationPrompts,
  buildAnswerRecoveryAdjudicationRequest,
  buildVisualEvidenceCheckRequest,
  type AnswerRecoveryAdjudicationRequest,
} from "../src/lib/meeting/answer-recovery-adjudication.js";

test("approved system prompt digests remain pinned without private corpora", () => {
  const identity = { logicalQuestionUnitId: "q", logicalQuestionUnitRevision: 1, questionText: "Explain the visible lines." };
  const resolution = buildAnswerRecoveryAdjudicationRequest({ ...identity, operationKind: "answer-resolution", answerRevision: 1, answerText: "Please supply the lines." })!;
  const visual = buildVisualEvidenceCheckRequest({ ...identity, questionSourceHash: "source" })!;
  for (const [request, digest] of [
    [resolution, "fd4ae4f24ba9e0ae3264d3305323ecf65410ddf2fcea6e1c91f5b2a49db6d4e2"],
    [visual, "c3f8a7687e22a62ce0c5ae22a60ba13f89b6a4750d3213d84d1aee8ba11fc5c7"],
  ] as const) {
    assert.equal(createHash("sha256").update(buildAnswerRecoveryAdjudicationPrompts(request).systemPrompt).digest("hex"), digest);
  }
});

// The immutable evaluation corpora stay private; no recording text is copied here.
const corpora = [
  {
    directory: "recovery-output-prompt-evaluation-2026-09-21",
    sha256: "2755323e1d7060d27efad02f63be4c3dc2bddbbeda5c0c7ded439e2ffc8a751a",
    kind: "evidence-requirement",
    arm: "new",
    count: 17,
    version: EVIDENCE_REQUIREMENT_PROMPT_VERSION,
  },
  {
    directory: "resolution-budget-prerequisite-evaluation-2026-09-22",
    sha256: "e9a0f902cc351a56e44c6329a0e8e8eefc8f5d78ea74be81e06a32eba35872a5",
    kind: "answer-resolution",
    arm: "B",
    count: 27,
    version: ANSWER_RESOLUTION_PROMPT_VERSION,
  },
] as const;

for (const fixture of corpora) {
  const file = path.resolve("evidence", fixture.directory, "corpus.json");
  test(`RC1 ${fixture.count} ${fixture.kind} inputs exactly match approved ${fixture.arm}`, {
    skip: !existsSync(file) && process.env.JARVIS_REQUIRE_3B_CORPORA !== "1"
      ? "Private evaluation corpus unavailable; RC1 acceptance requires JARVIS_REQUIRE_3B_CORPORA=1"
      : false,
  }, async () => {
    const bytes = readFileSync(file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
    const corpus = JSON.parse(bytes.toString());
    const samples = corpus.samples.filter((s: { kind: string }) => s.kind === fixture.kind);
    assert.equal(samples.length, fixture.count);
    const experiment = await import(pathToFileURL(path.resolve("evidence", fixture.directory, "prompts.mjs")).href);
    for (const sample of samples) {
      const request: AnswerRecoveryAdjudicationRequest = { ...sample.request, promptVersion: fixture.version };
      assert.notEqual(request.promptVersion, sample.request.promptVersion);
      const actual = buildAnswerRecoveryAdjudicationPrompts(request);
      assert.deepEqual(actual, sample.prompts[fixture.arm], sample.id);
      assert.deepEqual(JSON.parse(actual.userMessage), sample.payload, sample.id);
      assert.deepEqual(
        actual,
        experiment.comparisonPrompt(sample.prompts.old ?? sample.prompts.A, fixture.arm, fixture.kind),
        sample.id
      );
      if (fixture.arm === "B") {
        assert.notEqual(actual.systemPrompt, sample.prompts.C.systemPrompt);
        assert.equal(experiment.ARMS.B.maxOutputTokens, 512);
      }
    }
    assert.deepEqual(readFileSync(file), bytes, "the frozen corpus was not modified");
  });
}
