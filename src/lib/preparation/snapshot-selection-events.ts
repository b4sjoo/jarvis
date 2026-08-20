export type PreparationSnapshotSelectionChangeReason =
  | "current-context-changed"
  | "snapshot-activated"
  | "snapshot-deactivated";

export interface PreparationSnapshotSelectionChange {
  reason: PreparationSnapshotSelectionChangeReason;
  processId: string;
  roundId: string;
  snapshotId?: string;
  occurredAt: number;
}

type PreparationSnapshotSelectionListener = (
  change: PreparationSnapshotSelectionChange
) => void;

const listeners = new Set<PreparationSnapshotSelectionListener>();

export function publishPreparationSnapshotSelectionChange(
  change: PreparationSnapshotSelectionChange
) {
  for (const listener of [...listeners]) listener(change);
}

export function subscribeToPreparationSnapshotSelectionChanges(
  listener: PreparationSnapshotSelectionListener
) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
