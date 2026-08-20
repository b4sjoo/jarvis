import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreparationSnapshotSelectionChannel,
  type PreparationSnapshotSelectionChange,
  type PreparationSnapshotSelectionTransport,
} from "../src/lib/preparation/snapshot-selection-events.js";

test("preparation selection listeners receive changes until unsubscribed", async () => {
  const channel = createPreparationSnapshotSelectionChannel(
    createSharedTransport().transport
  );
  const received: PreparationSnapshotSelectionChange[] = [];
  const unsubscribe = channel.subscribe((change) => {
    received.push(change);
  });
  const activation: PreparationSnapshotSelectionChange = {
    reason: "snapshot-activated",
    processId: "process-1",
    roundId: "round-1",
    snapshotId: "snapshot-1",
    selectionRevision: 1,
    occurredAt: 100,
  };

  channel.publish(activation);
  unsubscribe();
  channel.publish({
    ...activation,
    reason: "snapshot-deactivated",
    selectionRevision: 2,
    occurredAt: 200,
  });
  await settle();

  assert.deepEqual(received, [activation]);
});

test("app-wide transport bridges channels and drops duplicate or stale revisions", async () => {
  const shared = createSharedTransport();
  const dashboard = createPreparationSnapshotSelectionChannel(shared.transport);
  const main = createPreparationSnapshotSelectionChannel(shared.transport);
  const received: PreparationSnapshotSelectionChange[] = [];
  let readyCount = 0;
  const unsubscribe = main.subscribe(
    (change) => received.push(change),
    () => {
      readyCount += 1;
    }
  );
  await settle();
  assert.equal(readyCount, 1);

  const activation: PreparationSnapshotSelectionChange = {
    reason: "snapshot-activated",
    processId: "process-1",
    roundId: "round-1",
    snapshotId: "snapshot-1",
    selectionRevision: 4,
    occurredAt: 100,
  };
  dashboard.publish(activation);
  dashboard.publish({
    ...activation,
    reason: "current-context-changed",
    occurredAt: 110,
  });
  dashboard.publish({
    ...activation,
    reason: "snapshot-deactivated",
    selectionRevision: 3,
    occurredAt: 120,
  });
  await settle();

  assert.deepEqual(received, [activation]);
  unsubscribe();
  dashboard.publish({
    ...activation,
    reason: "snapshot-deactivated",
    selectionRevision: 5,
    occurredAt: 130,
  });
  await settle();
  assert.deepEqual(received, [activation]);
});

function createSharedTransport() {
  const listeners = new Set<
    (change: PreparationSnapshotSelectionChange) => void
  >();
  const transport: PreparationSnapshotSelectionTransport = {
    async publish(change) {
      for (const listener of [...listeners]) listener(change);
    },
    async subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { transport };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}
