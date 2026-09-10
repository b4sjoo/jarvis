import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const source = await readFile(
  path.join(
    process.cwd(),
    "src/pages/app/components/meeting/index.tsx"
  ),
  "utf8"
);

test("keeps final task settlement visible without duplicate relation shadow controls", () => {
  assert.match(source, />\s*Task settlement\s*</);
  assert.doesNotMatch(source, /LLM relation adjudication \(Shadow\)/);
  assert.doesNotMatch(source, /taskRelationAdjudicationCandidateRelation/);
  assert.doesNotMatch(source, /taskRelationAdjudicationWouldRepair/);

  assert.doesNotMatch(source, /LLM type adjudication \(Shadow\)/);
  assert.match(source, /Runtime type adjudication/);
  assert.doesNotMatch(source, /Runtime type adjudication labels/);
  assert.doesNotMatch(source, /updateTaxonomyAdjudicationEvaluation/);
  assert.match(source, /kind: "expected-task-settlement"/);
  assert.match(source, /expectedQuestionType/);
  assert.doesNotMatch(source, /Response-only handling/);
  assert.doesNotMatch(
    source,
    /responseOnlyCorrect:\s*value === "correct"/
  );
});
