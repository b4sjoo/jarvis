import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "src/hooks/useMeetingAssistant.ts",
  "utf8"
);

test("publishes a Screen settlement only after its lifecycle receipt", () => {
  const start = source.indexOf(
    "// SCREEN_COMMITTED_SETTLEMENT_CONSUMER_BARRIER"
  );
  const end = source.indexOf(
    "const screenPostTransitionContextState",
    start
  );
  const block = source.slice(start, end);
  const transitionCommit = block.indexOf(
    "commitSourceOwnedTransitionWithManager({"
  );
  const transitionRejection = block.indexOf(
    "if (!screenTransitionCommitted)"
  );
  const settlementPublication = block.indexOf(
    "currentQuestionSettlementRef.current ="
  );
  const ledgerAdmissionStart = block.indexOf(
    "const screenEffectiveQuestionSourceRecord ="
  );
  const ledgerAdmissionEnd = block.indexOf(
    "if (screenEffectiveQuestionSourceRecord)",
    ledgerAdmissionStart
  );
  const ledgerAdmission = block.slice(
    ledgerAdmissionStart,
    ledgerAdmissionEnd
  );

  assert.ok(start >= 0 && end > start);
  assert.ok(transitionCommit >= 0);
  assert.ok(transitionRejection > transitionCommit);
  assert.ok(settlementPublication > transitionRejection);
  assert.match(
    block,
    /screenLifecyclePublicationAuthorized[\s\S]*sourceOwnedTransitionDurablySatisfied/
  );
  assert.match(
    block,
    /screenEffectiveQuestionSourceRecord[\s\S]*createEffectiveQuestionSourceRecord/
  );
  assert.ok(
    ledgerAdmissionStart >= 0 && ledgerAdmissionEnd > ledgerAdmissionStart
  );
  assert.match(
    ledgerAdmission,
    /screenLifecyclePublicationAuthorized\s*&&\s*!screenCurrentOnly/
  );
  assert.doesNotMatch(
    ledgerAdmission,
    /sourceOwnedTransitionDurablySatisfied/
  );
  assert.match(block, /committed-no-lifecycle-required/);
});
