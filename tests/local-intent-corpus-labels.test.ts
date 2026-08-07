import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCorpusLabelLedger,
  normalizeLabelCandidateDisposition,
} from "../scripts/lib/local-intent-corpus-labels.js";
import type { CorpusLabelCandidate } from "../scripts/lib/local-intent-corpus-schema.js";

test("admits only exact complete confirmed human labels as gold", () => {
  const human = candidate({
    candidateId: "human",
    authority: "human-confirmed",
    confirmation: "confirmed",
    sourceJoin: "exact-turn",
    sourceIntegrity: "complete",
    value: "general-system-design",
  });
  const runtime = candidate({
    candidateId: "runtime",
    authority: "runtime-observed",
    value: "coding",
  });
  const result = buildCorpusLabelLedger({
    exampleIds: ["example"],
    candidates: [human, runtime],
  });

  assert.equal(result.ledger[0].heads["question-type"].state, "gold");
  assert.equal(
    result.ledger[0].heads["question-type"].value,
    "general-system-design"
  );
  assert.ok(
    result.reviewQueue.some(
      (item) => item.reason === "gold-weak-disagreement"
    )
  );
});

test("keeps timestamp human evidence and generated-output inference out of gold", () => {
  const timestamp = candidate({
    candidateId: "timestamp",
    authority: "human-confirmed",
    confirmation: "confirmed",
    sourceJoin: "timestamp",
    sourceIntegrity: "complete",
    value: "coding",
  });
  const generated = candidate({
    candidateId: "generated",
    authority: "generated-output",
    value: "coding",
  });
  const result = buildCorpusLabelLedger({
    exampleIds: ["example"],
    candidates: [timestamp, generated],
  });

  assert.notEqual(result.ledger[0].heads["question-type"].state, "gold");
  assert.equal(result.ledger[0].heads["question-type"].lossEligible, false);
  assert.ok(
    result.reviewQueue.some((item) => item.reason === "timestamp-only-join")
  );
});

test("preserves unknown and not-applicable as different label semantics", () => {
  const unknown = candidate({
    candidateId: "unknown",
    authority: "manual-correction",
    confirmation: "confirmed",
    sourceJoin: "exact-lqu",
    sourceIntegrity: "complete",
    value: "unknown",
  });
  const notApplicable = normalizeLabelCandidateDisposition({
    ...candidateBase(),
    candidateId: "not-applicable",
    head: "speech-act",
    value: "acknowledgement",
    applicability: "not-applicable",
    authority: "human-confirmed",
    confirmation: "confirmed",
    sourceJoin: "exact-turn",
    sourceIntegrity: "complete",
  });
  const result = buildCorpusLabelLedger({
    exampleIds: ["example"],
    candidates: [unknown, notApplicable],
  });

  assert.equal(result.ledger[0].heads["question-type"].value, "unknown");
  assert.equal(result.ledger[0].heads["question-type"].lossEligible, true);
  assert.equal(
    result.ledger[0].heads["speech-act"].applicability,
    "not-applicable"
  );
  assert.equal(result.ledger[0].heads["speech-act"].lossEligible, false);
});

test("routes legacy human labels to explicit taxonomy review", () => {
  const legacy = candidate({
    candidateId: "legacy",
    authority: "legacy-human",
    confirmation: "confirmed",
    sourceJoin: "exact-turn",
    sourceIntegrity: "complete",
    value: "system-design",
  });
  const result = buildCorpusLabelLedger({
    exampleIds: ["example"],
    candidates: [legacy],
  });

  assert.equal(result.ledger[0].heads["question-type"].state, "blocked");
  assert.ok(
    result.reviewQueue.some((item) => item.reason === "legacy-taxonomy")
  );
});

function candidate(
  overrides: Partial<Omit<CorpusLabelCandidate, "disposition">>
): CorpusLabelCandidate {
  return normalizeLabelCandidateDisposition({
    ...candidateBase(),
    ...overrides,
  });
}

function candidateBase(): Omit<CorpusLabelCandidate, "disposition"> {
  return {
    schemaVersion: 1,
    candidateId: "candidate",
    exampleId: "example",
    head: "question-type",
    value: "coding",
    applicability: "applicable",
    authority: "runtime-observed",
    confirmation: "none",
    sourceJoin: "exact-lqu",
    sourceIntegrity: "complete",
    supportingEventIds: [],
    conflictIds: [],
  };
}
