import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(
  `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
  "utf8"
);

test("routes a late valid preflight through the bounded repair lease", () => {
  const callbackStart = hookSource.indexOf(
    "onLateResult: (lateResult) => {"
  );
  const callbackEnd = hookSource.indexOf(
    "const preflightPromise",
    callbackStart
  );
  assert.ok(callbackStart >= 0);
  assert.ok(callbackEnd > callbackStart);
  const callback = hookSource.slice(callbackStart, callbackEnd);

  assert.match(callback, /authorizeLateScreenPreflightRepair\(\{/);
  assert.match(callback, /stage: "candidate"/);
  assert.match(callback, /currentObservationId:/);
  assert.match(callback, /currentSettlementId:/);
  assert.match(callback, /currentVisibleAnswerRevision:/);
  assert.match(callback, /currentManualCorrectionRevision:/);
  assert.match(callback, /responseActionRevisionRef\.current \+= 1/);
  assert.match(callback, /late-valid-screen-preflight-repair/);
});

test("replays the same observation through the existing Screen pipeline", () => {
  assert.match(
    hookSource,
    /const observation = latePreflightRepair\s+\? latePreflightRepair\.observation/
  );
  assert.match(
    hookSource,
    /let screenPreflight: ScreenPreflightResult \| undefined =\s+latePreflightRepair\?\.preflight/
  );
  assert.match(
    hookSource,
    /latePreflightRepair: repair/
  );
  assert.match(
    hookSource,
    /stage: "replay"/
  );
});
