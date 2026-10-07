import { MEETING_FOCUS_SCHEMA_VERSION } from "./focus-window.js";
import type { MeetingFocusAction, MeetingFocusSnapshot, MeetingFocusWindowKind, MeetingFocusProtocolAction, MeetingFocusSnapshotEnvelope, MeetingFocusUserAction } from "./focus-window.js";
import { createMeetingFocusDisplayModel, readMeetingFocusDisplay, sameMeetingFocusDisplay } from "./focus-display.js";
import type { ManualCorrectionMenu, MeetingFocusCorrectionMenuRequest, MeetingFocusCorrectionMenuResponse } from "./focus-window.js";
import type { AdviseDisplayTarget } from "./manual-advise-display.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";

export interface MeetingFocusTransport {
  subscribe(receive: (payload: unknown) => void): Promise<() => void>;
  send(payload: unknown): Promise<void>;
}
type Applied = Extract<MeetingFocusProtocolAction, { type: "snapshot-applied" }>;
export type MeetingFocusProtocolObservation = Readonly<{
  event: "listener-ready" | "published" | "received" | "applied" | "rejected";
  publisherInstanceId?: string;
  sequence?: number;
  windowKind?: MeetingFocusWindowKind;
  reason?: string;
  displayTarget?: import("./manual-advise-display.js").AdviseDisplayTarget;
  adviseLocked?: boolean;
}>;
type Options = {
  transport: MeetingFocusTransport;
  onError(error: Error): void;
  observe?(observation: MeetingFocusProtocolObservation): void;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const role = (value: unknown): value is MeetingFocusWindowKind => value === "answer" || value === "controls";
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const versionError = () => new Error("Unsupported Focus snapshot version. Reopen Focus windows.");

/** start() must complete before opening native windows. ACK never calls onAction/publish. */
export function createMeetingFocusPublisher(options: Options & {
  publisherInstanceId?: string;
  onAction(action: MeetingFocusUserAction): void;
}) {
  const publisherInstanceId = options.publisherInstanceId ?? crypto.randomUUID();
  let current: MeetingFocusSnapshotEnvelope | undefined;
  let disposed = false;
  let ready = false;
  let unlisten: (() => void) | undefined;
  let starting: Promise<void> | undefined;
  const requests = new Map<MeetingFocusWindowKind, string>();
  const waiting = new Set<MeetingFocusWindowKind>();
  const applied = new Map<MeetingFocusWindowKind, Applied>();
  const send = async (envelope: MeetingFocusSnapshotEnvelope | MeetingFocusCorrectionMenuResponse) => {
    if (disposed) return;
    try { await options.transport.send(envelope); }
    catch (error) { if (!disposed) options.onError(asError(error)); }
  };
  const respond = (windowKind: MeetingFocusWindowKind, requestId: string) => {
    if (current) void send({ ...current, windowKind, requestId });
  };
  const receive = (message: unknown) => {
    if (disposed || !record(message)) return;
    if (message.type === "request-snapshot" || message.type === "snapshot-applied") {
      if (message.schemaVersion !== MEETING_FOCUS_SCHEMA_VERSION) { options.onError(versionError()); return; }
      if (!role(message.windowKind) || !id(message.requestId)) return;
      if (message.type === "request-snapshot") {
        if (message.publisherInstanceId !== undefined && message.publisherInstanceId !== publisherInstanceId) return;
        if (requests.get(message.windowKind) !== message.requestId) {
          requests.set(message.windowKind, message.requestId);
          applied.delete(message.windowKind);
        }
        if (current) respond(message.windowKind, message.requestId);
        else waiting.add(message.windowKind);
      } else {
        if (message.publisherInstanceId !== publisherInstanceId || !sequence(message.sequence) ||
            message.sequence > (current?.sequence ?? 0) || requests.get(message.windowKind) !== message.requestId ||
            message.sequence <= (applied.get(message.windowKind)?.sequence ?? 0)) {
          options.observe?.({ event: "rejected", reason: "stale-ack", windowKind: message.windowKind });
          return;
        }
        const ack = message as Applied;
        applied.set(ack.windowKind, Object.freeze({ ...ack }));
        options.observe?.({ event: "applied", publisherInstanceId, sequence: ack.sequence, windowKind: ack.windowKind,
          displayTarget: ack.displayTarget, adviseLocked: ack.adviseLocked });
      }
      return;
    }
    // Product intents retain their existing payload and runtime authority checks.
    switch (message.type) {
      case "request-correction-menu":
        if (message.schemaVersion === MEETING_FOCUS_SCHEMA_VERSION &&
            message.publisherInstanceId === publisherInstanceId && role(message.windowKind) &&
            id(message.requestId) && record(message.displayTarget) && id(message.correctedType)) {
          options.onAction(message as MeetingFocusCorrectionMenuRequest);
        }
        return;
      case "toggle-advise-pin": case "response-action":
      case "toggle-listening": case "regenerate": case "force-advise": case "capture-screen":
      case "submit-correction": case "deactivate-correction": case "correct-question-type":
      case "update-interview-types": case "clarifying-answer": case "new-task": case "same-task":
      case "dismiss-clarifying-question": options.onAction(message as MeetingFocusUserAction);
    }
  };
  return {
    publisherInstanceId,
    start(): Promise<void> {
      starting ??= (async () => {
        try {
          const cleanup = await options.transport.subscribe(receive);
          if (disposed) { cleanup(); return; }
          unlisten = cleanup;
          ready = true;
          options.observe?.({ event: "listener-ready", publisherInstanceId });
          if (current) await send(current);
        } catch (error) { if (!disposed) options.onError(asError(error)); throw error; }
      })();
      return starting;
    },
    async publish(payload: MeetingFocusSnapshot, publication?: { force?: boolean }): Promise<void> {
      if (disposed) return;
      const display = createMeetingFocusDisplayModel(payload);
      if (!publication?.force && sameMeetingFocusDisplay(current?.payload, display)) return;
      current = Object.freeze({ schemaVersion: MEETING_FOCUS_SCHEMA_VERSION, publisherInstanceId,
        sequence: (current?.sequence ?? 0) + 1, payload: display });
      options.observe?.({ event: "published", publisherInstanceId, sequence: current.sequence });
      if (ready) {
        await send(current);
        // A listener can request before the first display projection is available.
        for (const windowKind of waiting) respond(windowKind, requests.get(windowKind)!);
        waiting.clear();
      }
    },
    getLatestApplied(windowKind: MeetingFocusWindowKind) { return applied.get(windowKind); },
    respondCorrectionMenu(request: MeetingFocusCorrectionMenuRequest, menu: ManualCorrectionMenu) {
      if (request.publisherInstanceId !== publisherInstanceId) return Promise.resolve();
      return send({ type: "correction-menu", schemaVersion: MEETING_FOCUS_SCHEMA_VERSION,
        publisherInstanceId, windowKind: request.windowKind, requestId: request.requestId, menu });
    },
    dispose() { disposed = true; unlisten?.(); unlisten = undefined; requests.clear(); waiting.clear(); applied.clear(); },
  };
}

/** Receives ordered DTOs; the React consumer separately calls applied() after its commit. */
export function createMeetingFocusConsumer(options: Options & {
  windowKind: MeetingFocusWindowKind;
  onSnapshot(envelope: MeetingFocusSnapshotEnvelope): void;
  createRequestId?: () => string;
}) {
  let disposed = false;
  let ready = false;
  let unlisten: (() => void) | undefined;
  let starting: Promise<void> | undefined;
  let current: MeetingFocusSnapshotEnvelope | undefined;
  let candidate: MeetingFocusSnapshotEnvelope | undefined;
  let pending: { requestId: string; publisherInstanceId?: string } | undefined;
  let currentRequestId: string | undefined;
  let lastApplied = 0;
  const retired = new Set<string>();
  let menuRequest: { requestId: string; publisherInstanceId: string;
    finish(menu?: ManualCorrectionMenu, error?: Error): void } | undefined;
  const send = async (action: MeetingFocusAction) => {
    if (disposed) return;
    try { await options.transport.send(action); }
    catch (error) { if (!disposed) options.onError(asError(error)); }
  };
  const request = (publisherInstanceId?: string) => {
    if (!ready || disposed) return;
    if (pending?.publisherInstanceId && pending.publisherInstanceId !== publisherInstanceId) {
      retired.add(pending.publisherInstanceId);
    }
    pending = { requestId: (options.createRequestId ?? (() => crypto.randomUUID()))(), publisherInstanceId };
    void send({ type: "request-snapshot", schemaVersion: MEETING_FOCUS_SCHEMA_VERSION,
      windowKind: options.windowKind, ...pending });
  };
  const reject = (reason: string) => options.observe?.({ event: "rejected", windowKind: options.windowKind, reason });
  const receive = (message: unknown) => {
    if (disposed || !ready || !record(message)) return;
    if (message.schemaVersion !== MEETING_FOCUS_SCHEMA_VERSION) {
      reject("schema-version"); options.onError(versionError()); return;
    }
    if (message.type === "correction-menu") {
      if (message.windowKind !== options.windowKind) return;
      if (!menuRequest || message.requestId !== menuRequest.requestId ||
          message.publisherInstanceId !== menuRequest.publisherInstanceId ||
          message.publisherInstanceId !== current?.publisherInstanceId) {
        reject("menu-request-correlation"); return;
      }
      if (!record(message.menu) || !Array.isArray(message.menu.options) ||
          message.menu.options.length > 7) {
        menuRequest.finish(undefined, new Error("Invalid correction menu. Reopen the type menu.")); return;
      }
      menuRequest.finish(structuredClone(message.menu) as ManualCorrectionMenu);
      return;
    }
    if (!id(message.publisherInstanceId) || !sequence(message.sequence)) { reject("invalid-envelope"); return; }
    const publisherInstanceId = message.publisherInstanceId;
    if (retired.has(publisherInstanceId)) { reject("retired-publisher"); return; }
    const response = message.requestId !== undefined || message.windowKind !== undefined;
    if (response) {
      if (message.windowKind !== options.windowKind) return;
      if (!pending || message.requestId !== pending.requestId ||
          (pending.publisherInstanceId !== undefined && publisherInstanceId !== pending.publisherInstanceId)) {
        reject("request-correlation"); return;
      }
    } else if (publisherInstanceId !== current?.publisherInstanceId) {
      // A foreign broadcast can prompt a handshake, but can never establish an owner.
      if (!candidate || candidate.publisherInstanceId !== publisherInstanceId || candidate.sequence < message.sequence) {
        try {
          candidate = { schemaVersion: MEETING_FOCUS_SCHEMA_VERSION, publisherInstanceId,
            sequence: message.sequence, payload: readMeetingFocusDisplay(message.payload) };
        } catch (error) { reject("invalid-payload"); options.onError(asError(error)); return; }
      }
      if (!pending || pending.publisherInstanceId !== publisherInstanceId) request(publisherInstanceId);
      reject("handshake-required"); return;
    }
    // Confirmation may arrive behind a newer broadcast from this same candidate.
    const newerCandidate = response && candidate?.publisherInstanceId === publisherInstanceId && candidate.sequence > message.sequence
      ? candidate : undefined;
    const nextSequence = newerCandidate?.sequence ?? message.sequence;
    if (publisherInstanceId === current?.publisherInstanceId && nextSequence <= current.sequence) {
      reject("stale-sequence"); return;
    }
    let payload: MeetingFocusSnapshot;
    try { payload = readMeetingFocusDisplay(newerCandidate?.payload ?? message.payload); }
    catch (error) { reject("invalid-payload"); options.onError(asError(error)); return; }
    if (publisherInstanceId !== current?.publisherInstanceId) {
      menuRequest?.finish(undefined, new Error("The main window changed. Reopen the type menu."));
      if (current) retired.add(current.publisherInstanceId);
      lastApplied = 0;
    }
    if (response) { currentRequestId = pending!.requestId; pending = undefined; candidate = undefined; }
    current = Object.freeze({ schemaVersion: MEETING_FOCUS_SCHEMA_VERSION, publisherInstanceId,
      sequence: nextSequence, payload });
    options.observe?.({ event: "received", publisherInstanceId, sequence: current.sequence, windowKind: options.windowKind });
    options.onSnapshot(current);
  };
  return {
    start(): Promise<void> {
      starting ??= (async () => {
        try {
          const cleanup = await options.transport.subscribe(receive);
          if (disposed) { cleanup(); return; }
          unlisten = cleanup;
          ready = true;
          options.observe?.({ event: "listener-ready", windowKind: options.windowKind });
          request();
        } catch (error) { if (!disposed) options.onError(asError(error)); throw error; }
      })();
      return starting;
    },
    applied(envelope: MeetingFocusSnapshotEnvelope) {
      if (disposed || !currentRequestId || envelope !== current || envelope.sequence <= lastApplied) return;
      lastApplied = envelope.sequence;
      void send({ type: "snapshot-applied", schemaVersion: MEETING_FOCUS_SCHEMA_VERSION,
        displayTarget: envelope.payload.advisePin?.target,
        adviseLocked: envelope.payload.advisePin?.locked,
        publisherInstanceId: envelope.publisherInstanceId, sequence: envelope.sequence,
        windowKind: options.windowKind, requestId: currentRequestId });
    },
    dispatch(action: MeetingFocusUserAction) { return send(action); },
    requestCorrectionMenu(correctedType: CanonicalQuestionType, displayTarget: AdviseDisplayTarget, signal?: AbortSignal): Promise<ManualCorrectionMenu> {
      menuRequest?.finish(undefined, new Error("Correction menu request replaced."));
      if (disposed || !current || signal?.aborted) return Promise.reject(new Error("Focus is not ready. Reopen the type menu."));
      const publisherInstanceId = current.publisherInstanceId;
      const requestId = (options.createRequestId ?? (() => crypto.randomUUID()))();
      return new Promise((resolve, rejectRequest) => {
        const cancel = () => finish(undefined, new Error("Correction menu closed."));
        const timeout = setTimeout(() => finish(undefined, new Error("The main window did not respond. Reopen the type menu.")), 10_000);
        const finish = (menu?: ManualCorrectionMenu, error?: Error) => {
          if (menuRequest?.requestId !== requestId) return;
          menuRequest = undefined;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
          if (menu) resolve(menu); else rejectRequest(error);
        };
        menuRequest = { requestId, publisherInstanceId, finish };
        signal?.addEventListener("abort", cancel, { once: true });
        void options.transport.send({ type: "request-correction-menu", schemaVersion: MEETING_FOCUS_SCHEMA_VERSION,
          publisherInstanceId, windowKind: options.windowKind, requestId, correctedType,
          displayTarget: { ...displayTarget } } satisfies MeetingFocusCorrectionMenuRequest)
          .catch(error => finish(undefined, asError(error)));
      });
    },
    dispose() { disposed = true; menuRequest?.finish(undefined, new Error("Focus window closed.")); unlisten?.(); unlisten = undefined; },
  };
}
