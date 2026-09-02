export type AsyncListenerCleanup = () => void;

export interface SharedAsyncListenerLifecycle {
  acquire(): AsyncListenerCleanup;
}

export function createSharedAsyncListenerLifecycle(input: {
  setup: () => Promise<AsyncListenerCleanup[]>;
  onSetupError?: (error: unknown) => void;
  onCleanupError?: (error: unknown) => void;
}): SharedAsyncListenerLifecycle {
  let subscribers = 0;
  let installed: AsyncListenerCleanup[] = [];
  let setupPromise: Promise<void> | null = null;

  const cleanup = (listeners: AsyncListenerCleanup[]) => {
    for (const unlisten of listeners) {
      try {
        unlisten();
      } catch (error) {
        input.onCleanupError?.(error);
      }
    }
  };

  const cleanupInstalled = () => {
    const listeners = installed;
    installed = [];
    cleanup(listeners);
  };

  const ensureSetup = () => {
    if (setupPromise || installed.length > 0) return;
    setupPromise = (async () => {
      try {
        const listeners = await input.setup();
        if (subscribers === 0) {
          cleanup(listeners);
        } else {
          installed = listeners;
        }
      } catch (error) {
        input.onSetupError?.(error);
      } finally {
        setupPromise = null;
      }
    })();
  };

  return {
    acquire() {
      subscribers += 1;
      ensureSetup();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers = Math.max(0, subscribers - 1);
        if (subscribers === 0) cleanupInstalled();
      };
    },
  };
}
