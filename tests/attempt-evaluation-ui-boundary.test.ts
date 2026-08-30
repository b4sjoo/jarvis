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

  const typeLabelsStart = source.indexOf("LLM type adjudication labels");
  const typeLabelsEnd = source.indexOf(
    "{advisorTurnIntent ?",
    typeLabelsStart
  );
  assert.ok(typeLabelsStart >= 0);
  assert.ok(typeLabelsEnd > typeLabelsStart);
  const typeLabels = source.slice(typeLabelsStart, typeLabelsEnd);
  assert.match(typeLabels, /label="Type"/);
  assert.doesNotMatch(typeLabels, /label="Relation"/);
  assert.doesNotMatch(typeLabels, /label="Expected relation"/);
  assert.doesNotMatch(typeLabels, /label="Parent decision"/);
  assert.doesNotMatch(typeLabels, /label="Response-only"/);
  assert.doesNotMatch(typeLabels, /label="Context outcome"/);
});
