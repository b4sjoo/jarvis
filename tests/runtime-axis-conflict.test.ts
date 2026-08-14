import assert from "node:assert/strict";
import test from "node:test";
import {
  detectRuntimeAxisConflict,
  formatRuntimeAxisConflictForTrace,
} from "../src/lib/meeting/runtime-axis-conflict.js";

test("detects disagreement only between production-eligible proposals on one axis", () => {
  const decision = detectRuntimeAxisConflict({
    axis: "question-type",
    proposals: [
      {
        source: "answer-focus-lexical",
        value: "general-system-design",
        eligible: true,
        productionEligible: true,
      },
      {
        source: "section-hint",
        value: "coding",
        eligible: true,
        productionEligible: true,
      },
      {
        source: "semantic-prototype",
        value: "field-knowledge",
        eligible: true,
        productionEligible: false,
      },
    ],
  });

  assert.equal(decision.conflict, true);
  assert.equal(decision.reason, "eligible-proposals-disagree");
  assert.deepEqual(decision.values, ["general-system-design", "coding"]);
  assert.deepEqual(decision.sources, [
    "answer-focus-lexical",
    "section-hint",
  ]);
});

test("does not manufacture a conflict from one producer or shadow evidence", () => {
  const decision = detectRuntimeAxisConflict({
    axis: "question-type",
    proposals: [
      {
        source: "answer-focus-lexical",
        value: "coding",
        eligible: true,
        productionEligible: true,
      },
      {
        source: "semantic-prototype",
        value: "general-system-design",
        eligible: true,
        productionEligible: false,
      },
    ],
  });

  assert.equal(decision.conflict, false);
  assert.equal(decision.reason, "insufficient-eligible-proposals");
  assert.deepEqual(
    formatRuntimeAxisConflictForTrace(decision, "questionTypeAxis"),
    {
      questionTypeAxisConflictAxis: "question-type",
      questionTypeAxisConflictDetected: false,
      questionTypeAxisConflictReason: "insufficient-eligible-proposals",
      questionTypeAxisConflictEligibleProposalCount: 1,
      questionTypeAxisConflictSources: ["answer-focus-lexical"],
      questionTypeAxisConflictValues: ["coding"],
    }
  );
});
