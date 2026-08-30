import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(
  `${process.cwd()}/src/hooks/useMeetingAssistant.ts`,
  "utf8"
);

test("defers a late valid preflight until the current settlement exists", () => {
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

  assert.match(callback, /pendingLatePreflightCandidate = \{/);
  assert.match(callback, /lateScreenPreflightRepairAwaitingSettlement: true/);
  assert.match(callback, /schedulePendingLatePreflightRepair\(\)/);
  assert.doesNotMatch(callback, /settlementId:\s+currentSettlement/);
  assert.doesNotMatch(callback, /responseActionRevisionRef\.current \+= 1/);
});

test("binds the repair lease to the current Screen settlement", () => {
  const schedulerStart = hookSource.indexOf(
    "const schedulePendingLatePreflightRepair = () => {"
  );
  const schedulerEnd = hookSource.indexOf(
    "screenCaptureSucceeded = true",
    schedulerStart
  );
  assert.ok(schedulerStart >= 0);
  assert.ok(schedulerEnd > schedulerStart);
  const scheduler = hookSource.slice(schedulerStart, schedulerEnd);

  assert.match(scheduler, /const settlement = screenCurrentQuestionSettlement/);
  assert.match(scheduler, /settlementId: settlement\.settlementId/);
  assert.match(scheduler, /settlementRevision: settlement\.revision/);
  assert.match(scheduler, /authorizeLateScreenPreflightRepair\(\{/);
  assert.match(scheduler, /stage: "candidate"/);
  assert.match(scheduler, /responseActionRevisionRef\.current \+= 1/);
  assert.match(scheduler, /late-valid-screen-preflight-repair/);
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
