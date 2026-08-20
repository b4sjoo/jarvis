import { emit, listen } from "@tauri-apps/api/event";

export const PREPARATION_SNAPSHOT_SELECTION_EVENT =
  "preparation-snapshot-selection-invalidated";

export type PreparationSnapshotSelectionChangeReason =
  | "current-context-changed"
  | "snapshot-activated"
  | "snapshot-deactivated";

export interface PreparationSnapshotSelectionChange {
  reason: PreparationSnapshotSelectionChangeReason;
  processId: string;
  roundId: string;
  snapshotId?: string;
  selectionRevision: number;
  occurredAt: number;
}

type PreparationSnapshotSelectionListener = (
  change: PreparationSnapshotSelectionChange
) => void;

export interface PreparationSnapshotSelectionTransport {
  publish(change: PreparationSnapshotSelectionChange): Promise<void>;
  subscribe(
    listener: PreparationSnapshotSelectionListener
  ): Promise<() => void>;
}

export function createPreparationSnapshotSelectionChannel(
  transport: PreparationSnapshotSelectionTransport,
  onTransportError: (error: unknown) => void = () => {}
) {
  const listeners = new Set<PreparationSnapshotSelectionListener>();

  return {
    publish(change: PreparationSnapshotSelectionChange) {
      if (!isPreparationSnapshotSelectionChange(change)) return;
      for (const listener of [...listeners]) listener(change);
      void Promise.resolve()
        .then(() => transport.publish(change))
        .catch(onTransportError);
    },

    subscribe(
      listener: PreparationSnapshotSelectionListener,
      onTransportReady?: () => void
    ) {
      let disposed = false;
      let unlistenTransport: (() => void) | undefined;
      let latestRevision = -1;
      const deliver = (change: PreparationSnapshotSelectionChange) => {
        if (
          disposed ||
          !isPreparationSnapshotSelectionChange(change) ||
          change.selectionRevision <= latestRevision
        ) {
          return;
        }
        latestRevision = change.selectionRevision;
        listener(change);
      };

      listeners.add(deliver);
      void Promise.resolve()
        .then(() => transport.subscribe(deliver))
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlistenTransport = unlisten;
          onTransportReady?.();
        })
        .catch(onTransportError);

      return () => {
        disposed = true;
        listeners.delete(deliver);
        unlistenTransport?.();
      };
    },
  };
}

const appWideChannel = createPreparationSnapshotSelectionChannel(
  {
    publish: (change) => emit(PREPARATION_SNAPSHOT_SELECTION_EVENT, change),
    subscribe: (listener) =>
      listen<PreparationSnapshotSelectionChange>(
        PREPARATION_SNAPSHOT_SELECTION_EVENT,
        (event) => listener(event.payload)
      ),
  },
  (error) => {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      console.warn(
        "[interview-preparation] snapshot invalidation channel failed",
        error
      );
    }
  }
);

export function publishPreparationSnapshotSelectionChange(
  change: PreparationSnapshotSelectionChange
) {
  appWideChannel.publish(change);
}

export function subscribeToPreparationSnapshotSelectionChanges(
  listener: PreparationSnapshotSelectionListener,
  onTransportReady?: () => void
) {
  return appWideChannel.subscribe(listener, onTransportReady);
}

function isPreparationSnapshotSelectionChange(
  value: unknown
): value is PreparationSnapshotSelectionChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<PreparationSnapshotSelectionChange>;
  return (
    (change.reason === "current-context-changed" ||
      change.reason === "snapshot-activated" ||
      change.reason === "snapshot-deactivated") &&
    typeof change.processId === "string" &&
    change.processId.length > 0 &&
    typeof change.roundId === "string" &&
    change.roundId.length > 0 &&
    Number.isSafeInteger(change.selectionRevision) &&
    (change.selectionRevision ?? -1) >= 0 &&
    typeof change.occurredAt === "number" &&
    Number.isFinite(change.occurredAt)
  );
}
