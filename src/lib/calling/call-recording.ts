import { invoke } from "@tauri-apps/api/core";
import {
  isTauriRuntime,
  requireTauriRuntime,
} from "./runtime-environment.js";

export type CallRecordingState =
  | "open"
  | "closing"
  | "closed"
  | "close-failed"
  | "abandoned";

export type CallRecordingHealth =
  | "healthy"
  | "incomplete"
  | "close-failed";

export interface CallRecordingCompleteness {
  health: CallRecordingHealth;
  attemptedEventCount: number;
  persistedEventCount: number;
  droppedEventCount: number;
  incompletenessReasons: string[];
  terminalState: "closed" | "abandoned";
}

export interface CallRecordingStatus {
  callSessionId: string;
  recordingPath: string;
  state: CallRecordingState;
  attempt: number;
  eventCount: number;
  attemptedEventCount: number;
  persistedEventCount: number;
  droppedEventCount: number;
  health: CallRecordingHealth;
  incompletenessReasons: string[];
  startedAt: number;
  endedAt?: number;
  lastError?: string;
}

export interface CallRecordingSummary {
  status: CallRecordingStatus;
  humanEvaluationCount: number;
  manifestAvailable: boolean;
  integrityError: string | null;
}

export type CallRecordingEventKind =
  | "runtime-command"
  | "native-audio-lifecycle"
  | "native-audio-speech-start"
  | "native-audio-liveness"
  | "native-audio-segment-dropped"
  | "native-audio-event-rejected"
  | "audio-segment-observed"
  | "audio-segment-settled"
  | "audio-queue-observation"
  | "rollover-transcript-family"
  | "audio-settings-updated"
  | "model-settings-updated"
  | "shortcut-action"
  | "interface-action"
  | "stt-operation-dispatched"
  | "stt-operation-returned"
  | "model-operation-dispatched"
  | "model-operation-returned"
  | "human-evaluation"
  | "preparation-binding"
  | "snapshot-artifact-receipt"
  | "call-close-attempt";

export interface CallRecordingEvent {
  eventId: string;
  callSessionId: string;
  sequence: number;
  kind: CallRecordingEventKind;
  occurredAt: number;
  payload: unknown;
}

export interface CallRecordingTransport {
  start(input: {
    callSessionId: string;
    startedAt: number;
  }): Promise<CallRecordingStatus>;
  append(input: {
    callSessionId: string;
    eventPayload: string;
  }): Promise<CallRecordingStatus>;
  close(input: {
    callSessionId: string;
    endedAt: number;
    completeness?: CallRecordingCompleteness;
  }): Promise<CallRecordingStatus>;
  retry(input: {
    callSessionId: string;
    endedAt: number;
    completeness?: CallRecordingCompleteness;
  }): Promise<CallRecordingStatus>;
  abandon(input: {
    callSessionId: string;
    occurredAt: number;
    completeness?: CallRecordingCompleteness;
  }): Promise<CallRecordingStatus>;
}

const tauriTransport: CallRecordingTransport = {
  start: (input) => {
    requireTauriRuntime("Call recording");
    return invoke("start_call_recording", input);
  },
  append: (input) => {
    requireTauriRuntime("Call recording");
    return invoke("append_call_recording_event", input);
  },
  close: (input) => {
    requireTauriRuntime("Call recording");
    return invoke("close_call_recording", input);
  },
  retry: (input) => {
    requireTauriRuntime("Call recording recovery");
    return invoke("retry_call_recording_close", input);
  },
  abandon: (input) => {
    requireTauriRuntime("Call recording recovery");
    return invoke("abandon_call_recording", input);
  },
};

export class CallRecordingProjection {
  readonly callSessionId: string;
  readonly #transport: CallRecordingTransport;
  #status: CallRecordingStatus | null = null;
  #tail: Promise<void> = Promise.resolve();
  #attemptedEventCount = 0;
  #persistedEventCount = 0;
  #droppedEventCount = 0;
  #incompletenessReasons = new Set<string>();

  constructor(input: {
    callSessionId: string;
    transport?: CallRecordingTransport;
  }) {
    this.callSessionId = input.callSessionId;
    this.#transport = input.transport ?? tauriTransport;
  }

  get status() {
    if (!this.#status) return null;
    return structuredClone({
      ...this.#status,
      attemptedEventCount: this.#attemptedEventCount,
      persistedEventCount: this.#persistedEventCount,
      droppedEventCount: this.#droppedEventCount,
      health:
        this.#status.state === "close-failed"
          ? "close-failed"
          : this.#incompletenessReasons.size > 0
            ? "incomplete"
            : "healthy",
      incompletenessReasons: [...this.#incompletenessReasons],
    } satisfies CallRecordingStatus);
  }

  async start(startedAt: number) {
    this.#status = await this.#transport.start({
      callSessionId: this.callSessionId,
      startedAt,
    });
    this.#attemptedEventCount = this.#status.attemptedEventCount ?? 0;
    this.#persistedEventCount =
      this.#status.persistedEventCount ?? this.#status.eventCount;
    this.#droppedEventCount = this.#status.droppedEventCount ?? 0;
    this.#incompletenessReasons = new Set(
      this.#status.incompletenessReasons ?? []
    );
    return this.status;
  }

  append(kind: CallRecordingEventKind, payload: unknown, occurredAt = Date.now()) {
    const task = this.#tail.then(async () => {
      if (!this.#status) throw new Error("Call recording has not started.");
      this.#attemptedEventCount += 1;
      const sequence = this.#persistedEventCount + 1;
      const event: CallRecordingEvent = {
        eventId: `call-event-${crypto.randomUUID()}`,
        callSessionId: this.callSessionId,
        sequence,
        kind,
        occurredAt,
        payload: structuredClone(payload),
      };
      try {
        this.#status = await this.#transport.append({
          callSessionId: this.callSessionId,
          eventPayload: JSON.stringify(event),
        });
        this.#persistedEventCount = this.#status.eventCount;
      } catch (error) {
        this.#droppedEventCount += 1;
        this.markIncomplete(`append:${kind}:${message(error)}`);
        throw error;
      }
    });
    this.#tail = task.then(
      () => undefined,
      () => undefined
    );
    return task.then(() => this.status);
  }

  markIncomplete(reason: string) {
    const normalized = reason.trim().slice(0, 500);
    if (normalized) this.#incompletenessReasons.add(normalized);
    return this.status;
  }

  async drain() {
    await this.#tail;
    return this.status;
  }

  async close(endedAt: number) {
    await this.#tail;
    this.#status = await this.#transport.close({
      callSessionId: this.callSessionId,
      endedAt,
      completeness: this.#completeness("closed"),
    });
    this.#adoptStatus(this.#status);
    return this.status;
  }

  async retryClose(endedAt: number) {
    await this.#tail;
    this.#status = await this.#transport.retry({
      callSessionId: this.callSessionId,
      endedAt,
      completeness: this.#completeness("closed"),
    });
    this.#adoptStatus(this.#status);
    return this.status;
  }

  async abandon(occurredAt: number) {
    await this.#tail;
    this.#status = await this.#transport.abandon({
      callSessionId: this.callSessionId,
      occurredAt,
      completeness: this.#completeness("abandoned"),
    });
    this.#adoptStatus(this.#status);
    return this.status;
  }

  #completeness(terminalState: "closed" | "abandoned"): CallRecordingCompleteness {
    return {
      health: this.#incompletenessReasons.size ? "incomplete" : "healthy",
      attemptedEventCount: this.#attemptedEventCount,
      persistedEventCount: this.#persistedEventCount,
      droppedEventCount: this.#droppedEventCount,
      incompletenessReasons: [...this.#incompletenessReasons],
      terminalState,
    };
  }

  #adoptStatus(status: CallRecordingStatus) {
    this.#attemptedEventCount = Math.max(
      this.#attemptedEventCount,
      status.attemptedEventCount ?? 0
    );
    this.#persistedEventCount = Math.max(
      this.#persistedEventCount,
      status.persistedEventCount ?? status.eventCount
    );
    this.#droppedEventCount = Math.max(
      this.#droppedEventCount,
      status.droppedEventCount ?? 0
    );
    for (const reason of status.incompletenessReasons ?? []) {
      this.#incompletenessReasons.add(reason);
    }
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const listRecoverableCallRecordings = () =>
  isTauriRuntime()
    ? invoke<CallRecordingStatus[]>("list_recoverable_call_recordings")
    : Promise.resolve([]);

export const listCallRecordings = () =>
  isTauriRuntime()
    ? invoke<CallRecordingSummary[]>("list_call_recordings")
    : Promise.resolve([]);

export const revealCallRecordingsRoot = () => {
  requireTauriRuntime("Opening the recordings folder");
  return invoke<void>("reveal_call_recordings_root");
};

export const revealCallRecording = (callSessionId: string) => {
  requireTauriRuntime("Opening a call recording");
  return invoke<void>("reveal_call_recording", { callSessionId });
};

export const exportCallRecording = (callSessionId: string) => {
  requireTauriRuntime("Exporting a call recording");
  return invoke<string>("export_call_recording", { callSessionId });
};

export const retryRecoveredCallRecording = (
  callSessionId: string,
  endedAt = Date.now()
) => {
  requireTauriRuntime("Call recording recovery");
  return invoke<CallRecordingStatus>("retry_call_recording_close", {
    callSessionId,
    endedAt,
  });
};

export const abandonRecoveredCallRecording = (
  callSessionId: string,
  occurredAt = Date.now()
) => {
  requireTauriRuntime("Call recording recovery");
  return invoke<CallRecordingStatus>("abandon_call_recording", {
    callSessionId,
    occurredAt,
  });
};
