import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/hooks/useMeetingAssistant.ts",
  "utf8"
);

test("does not schedule the legacy Combined Intent observer", () => {
  const start = source.indexOf(
    "const scheduleSemanticTaxonomyShadow = useCallback"
  );
  const end = source.indexOf(
    "const scheduleAdvisorAfterQuestionTypeWindow",
    start
  );
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(block, /scheduleQuestionTypeAdjudication\(\{/);
  assert.match(block, /scheduleTaskRelationAdjudication\(\{/);
  assert.match(block, /legacyCombinedIntentSchedulingRetired: true/);
  assert.doesNotMatch(block, /scheduleTaxonomyAdjudicationShadow\(\{/);
});

test("keeps the ordered split chain without scheduling Direct Relation", () => {
  const start = source.indexOf(
    "const scheduleTaskRelationAdjudication = useCallback"
  );
  const end = source.indexOf(
    "const resolveOrderedTaskRelationWithinWindow",
    start
  );
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(block, /scheduleTaskRelationSplitRuntime\(\{/);
  assert.match(block, /legacyDirectRelationSchedulingRetired: true/);
  assert.doesNotMatch(
    block,
    /taskRelationAdjudicationRuntimeRef\.current!\.schedule/
  );
  assert.doesNotMatch(block, /requestTaskRelationAdjudication\(\{/);
});
