import type { NativeAudioLifecycleEvent } from "./native-audio-lifecycle.js";
import type { SttEvaluationCaptureState } from "./types.js";

export interface NativeStopLease {
  owner: "meeting" | "system";
  captureSessionId: string;
  captureGeneration: number;
}

/** A receipt waiter, not a capture owner. Call accept only after terminal evidence is enqueued. */
export function createNativeStopTerminalWait(lease: NativeStopLease) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return {
    lease, promise,
    accept(event: NativeAudioLifecycleEvent) {
      if (event.eventType === "started" || event.owner !== lease.owner
        || event.captureSessionId !== lease.captureSessionId
        || event.captureGeneration !== lease.captureGeneration) return false;
      // Terminated does not assert lossless audio or successful native encoding.
      resolve();
      return true;
    },
  };
}

export function assertShutdownQueueDrained(result: {
  timedOut: boolean;
  queueDepthAtDrainEnd: number;
  activeRequestCountAtDrainEnd: number;
}, microphoneQueueDepth: number) {
  if (result.timedOut || result.queueDepthAtDrainEnd !== 0
    || result.activeRequestCountAtDrainEnd !== 0 || microphoneQueueDepth !== 0) {
    throw new Error("Accepted audio work has not drained; Retry or explicitly Force Quit.");
  }
}

export async function stopShutdownEvaluationCapture(manager: {
  drain(): Promise<void>;
  stop(reason: string): Promise<SttEvaluationCaptureState>;
  getState(): SttEvaluationCaptureState;
} | null) {
  if (!manager) return;
  await manager.drain();
  // The existing write queue records errors in state instead of rejecting drain().
  if (manager.getState().lastError) throw new Error("STT evaluation has an unresolved write failure.");
  const state = await manager.stop("application-shutdown");
  if (state.active || state.lastError || (state.sessionId && !state.manifestFinalized)) {
    throw new Error("STT evaluation capture has not finalized.");
  }
}

export function createAcceptedTraceTerminalWait(traces: Array<{ id: string; status: string }>) {
  const pending = new Set(traces.filter((trace) => trace.status === "running").map((trace) => trace.id));
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  if (!pending.size) resolve();
  return {
    promise,
    accept(traces: Array<{ id: string; status: string }>) {
      for (const id of pending) {
        const trace = traces.find((item) => item.id === id);
        if (!trace) {
          reject(new Error("Accepted runtime trace was removed before terminal settlement."));
          return;
        }
        if (trace.status !== "running") pending.delete(id);
      }
      if (!pending.size) resolve();
    },
  };
}
