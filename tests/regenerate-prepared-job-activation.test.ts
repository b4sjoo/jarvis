import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync("src/hooks/useMeetingAssistant.ts", "utf8");
const regenerateStart = hookSource.indexOf(
  "const regenerateSuggestion = useCallback"
);
const regenerateEnd = hookSource.indexOf(
  "const setPreparationRuntimeCapabilities",
  regenerateStart
);
const regenerateSource = hookSource.slice(regenerateStart, regenerateEnd);

test("Regenerate activates its one prepared Advisor job before acceptance", () => {
  const targetIndex = regenerateSource.indexOf(
    "resolveVisibleAnswerResponseActionTarget"
  );
  const buildIndex = regenerateSource.indexOf(
    "const advisorJob = buildAdvisorJob"
  );
  const activateIndex = regenerateSource.indexOf(
    "activateAdvisorJob(advisorJob)"
  );
  const acceptedIndex = regenerateSource.indexOf('stage: "accepted"');
  const executeIndex = regenerateSource.indexOf("await runAdvisor({");

  assert.ok(targetIndex >= 0);
  assert.ok(buildIndex > targetIndex);
  assert.ok(activateIndex > buildIndex);
  assert.ok(acceptedIndex > activateIndex);
  assert.ok(executeIndex > acceptedIndex);
  assert.equal(
    (regenerateSource.match(/buildAdvisorJob\(/g) ?? []).length,
    1
  );
  assert.match(
    regenerateSource,
    /advisorJob,\s*currentQuestionSettlementOverride:\s*visibleTarget\.settlementSnapshot,\s*\}\);/
  );
  assert.match(
    regenerateSource,
    /logicalQuestionUnit: visibleTarget\.logicalQuestionUnit/
  );
  assert.match(
    regenerateSource,
    /currentQuestionSettlementOverride:\s*visibleTarget\.settlementSnapshot/
  );
});

test("Regenerate rejects a stale visible owner before building a job", () => {
  assert.match(
    regenerateSource,
    /if \(!visibleTarget\.authorized \|\| !visibleTarget\.logicalQuestionUnit\)[\s\S]*terminalDisposition: "stale"[\s\S]*reason: visibleTarget\.reason[\s\S]*return;/
  );
});

test("Regenerate terminalizes activation denial without executing", () => {
  assert.match(
    regenerateSource,
    /if \(!activateAdvisorJob\(advisorJob\)\)[\s\S]*terminalDisposition: "rejected"[\s\S]*reason: "advisor-job-activation-denied"[\s\S]*return;/
  );
});

test("Regenerate records its resolved visible owner after ingress", () => {
  assert.match(
    regenerateSource,
    /const resolvedLogicalQuestionUnit = visibleTarget\.logicalQuestionUnit/
  );
  assert.match(
    regenerateSource,
    /stage: "accepted",[\s\S]*observedLogicalQuestionUnitId: resolvedLogicalQuestionUnit\.id[\s\S]*observedLogicalQuestionUnitRevision:[\s\S]*resolvedLogicalQuestionUnit\.revision/
  );
  assert.doesNotMatch(
    regenerateSource.slice(
      regenerateSource.indexOf("const resolvedLogicalQuestionUnit"),
      regenerateSource.indexOf("const setPreparationRuntimeCapabilities")
    ),
    /observedLogicalQuestionUnitId: currentLogicalQuestionUnit\?\.id/
  );
});
