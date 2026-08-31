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
  const buildIndex = regenerateSource.indexOf(
    "const advisorJob = buildAdvisorJob"
  );
  const activateIndex = regenerateSource.indexOf(
    "activateAdvisorJob(advisorJob)"
  );
  const acceptedIndex = regenerateSource.indexOf('stage: "accepted"');
  const executeIndex = regenerateSource.indexOf("await runAdvisor({");

  assert.ok(buildIndex >= 0);
  assert.ok(activateIndex > buildIndex);
  assert.ok(acceptedIndex > activateIndex);
  assert.ok(executeIndex > acceptedIndex);
  assert.equal(
    (regenerateSource.match(/buildAdvisorJob\(/g) ?? []).length,
    1
  );
  assert.match(regenerateSource, /advisorJob,\s*\}\);/);
});

test("Regenerate terminalizes activation denial without executing", () => {
  assert.match(
    regenerateSource,
    /if \(!activateAdvisorJob\(advisorJob\)\)[\s\S]*terminalDisposition: "rejected"[\s\S]*reason: "advisor-job-activation-denied"[\s\S]*return;/
  );
});
