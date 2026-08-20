import assert from "node:assert/strict";
import test from "node:test";
import {
  publishPreparationSnapshotSelectionChange,
  subscribeToPreparationSnapshotSelectionChanges,
  type PreparationSnapshotSelectionChange,
} from "../src/lib/preparation/snapshot-selection-events.js";

test("preparation selection listeners receive changes until unsubscribed", () => {
  const received: PreparationSnapshotSelectionChange[] = [];
  const unsubscribe = subscribeToPreparationSnapshotSelectionChanges((change) => {
    received.push(change);
  });
  const activation: PreparationSnapshotSelectionChange = {
    reason: "snapshot-activated",
    processId: "process-1",
    roundId: "round-1",
    snapshotId: "snapshot-1",
    occurredAt: 100,
  };

  publishPreparationSnapshotSelectionChange(activation);
  unsubscribe();
  publishPreparationSnapshotSelectionChange({
    ...activation,
    reason: "snapshot-deactivated",
    occurredAt: 200,
  });

  assert.deepEqual(received, [activation]);
});
