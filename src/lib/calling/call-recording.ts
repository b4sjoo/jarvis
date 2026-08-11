import { invoke } from "@tauri-apps/api/core";

export type CallRecordingState =
  | "open"
  | "closing"
  | "closed"
  | "close-failed"
  | "abandoned";

export interface CallRecordingStatus {
  callSessionId: string;
  recordingPath: string;
  state: CallRecordingState;
  attempt: number;
  eventCount: number;
  startedAt: number;
  endedAt?: number;
  lastError?: string;
}

export type CallRecordingEventKind =
  | "runtime-command"
  | "native-audio-lifecycle"
  | "audio-segment-observed"
  | "audio-segment-settled"
  | "audio-settings-updated"
  | "model-settings-updated"
  | "shortcut-action"
  | "stt-operation-dispatched"
  | "stt-operation-returned"
  | "model-operation-dispatched"
  | "model-operation-returned"
  | "human-evaluation"
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
  }): Promise<CallRecordingStatus>;
  retry(input: {
    callSessionId: string;
    endedAt: number;
  }): Promise<CallRecordingStatus>;
  abandon(input: {
    callSessionId: string;
    occurredAt: number;
  }): Promise<CallRecordingStatus>;
}

const tauriTransport: CallRecordingTransport = {
  start: (input) => invoke("start_call_recording", input),
  append: (input) => invoke("append_call_recording_event", input),
  close: (input) => invoke("close_call_recording", input),
  retry: (input) => invoke("retry_call_recording_close", input),
  abandon: (input) => invoke("abandon_call_recording", input),
};

export class CallRecordingProjection {
  readonly callSessionId: string;
  readonly #transport: CallRecordingTransport;
  #status: CallRecordingStatus | null = null;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: {
    callSessionId: string;
    transport?: CallRecordingTransport;
  }) {
    this.callSessionId = input.callSessionId;
    this.#transport = input.transport ?? tauriTransport;
  }

  get status() {
    return this.#status ? structuredClone(this.#status) : null;
  }

  async start(startedAt: number) {
    this.#status = await this.#transport.start({
      callSessionId: this.callSessionId,
      startedAt,
    });
    return this.status;
  }

  append(kind: CallRecordingEventKind, payload: unknown, occurredAt = Date.now()) {
    const task = this.#tail.then(async () => {
      if (!this.#status) throw new Error("Call recording has not started.");
      const sequence = this.#status.eventCount + 1;
      const event: CallRecordingEvent = {
        eventId: `call-event-${crypto.randomUUID()}`,
        callSessionId: this.callSessionId,
        sequence,
        kind,
        occurredAt,
        payload: structuredClone(payload),
      };
      this.#status = await this.#transport.append({
        callSessionId: this.callSessionId,
        eventPayload: JSON.stringify(event),
      });
    });
    this.#tail = task.catch(() => undefined);
    return task.then(() => this.status);
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
    });
    return this.status;
  }

  async retryClose(endedAt: number) {
    await this.#tail;
    this.#status = await this.#transport.retry({
      callSessionId: this.callSessionId,
      endedAt,
    });
    return this.status;
  }

  async abandon(occurredAt: number) {
    await this.#tail;
    this.#status = await this.#transport.abandon({
      callSessionId: this.callSessionId,
      occurredAt,
    });
    return this.status;
  }
}

export const listRecoverableCallRecordings = () =>
  invoke<CallRecordingStatus[]>("list_recoverable_call_recordings");

export const retryRecoveredCallRecording = (
  callSessionId: string,
  endedAt = Date.now()
) =>
  invoke<CallRecordingStatus>("retry_call_recording_close", {
    callSessionId,
    endedAt,
  });

export const abandonRecoveredCallRecording = (
  callSessionId: string,
  occurredAt = Date.now()
) =>
  invoke<CallRecordingStatus>("abandon_call_recording", {
    callSessionId,
    occurredAt,
  });
