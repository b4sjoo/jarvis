// Tasks 145/183 NDI: the read-only projection of Native Stall Diagnostics.
//
// A leaf module with no imports. It owns the receipt value the Hook keeps for
// its arm and disarm requests and the pure function that turns (setting,
// recording, receipt) into what the configuration panel shows.
//
// Order. Receipts are ordered by the Hook-local request id. The native run id
// names a run and nothing else: native returns the same id when one recording
// is armed again, so it cannot tell which request a reply answers.
//
// Meaning. Armed means that the native observer started for the recording the
// request was issued in. It carries no statement about capture, audio health,
// sample permission or files on disk. Nothing here reads native state, the
// file system, Debug Mode or Runtime Cross-checks.

export const NATIVE_STALL_DIAGNOSTICS_EVIDENCE_SUBPATH =
  "diagnostics/native-stall";

// Shown when an arming request resolves without a run id. Native returns one
// for every successful arm; without it the request cannot be shown as armed.
export const NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE =
  "The native reply carried no run id.";

export type NativeStallDiagnosticsReceiptStatus =
  | "pending"
  | "armed"
  | "disarmed"
  | "failed";

// What the recording manager reports about its current recording.
export interface NativeStallDiagnosticsRecording {
  folderName?: string;
  sessionId?: string;
  folderPath?: string;
}

// The recording whose arming request native last answered with a run id. A
// disarm request issued while the switch is on carries it forward. The next
// arming request drops it, and so does a disarm issued while the switch is off.
export interface NativeStallDiagnosticsArmedRecording {
  folderName: string;
  recordingSessionId?: string;
  folderPath?: string;
  runId: string;
}

export interface NativeStallDiagnosticsReceipt {
  // Hook-local, strictly increasing. The only ordering key.
  requestId: number;
  enabled: boolean;
  // The recording captured when the request was enqueued.
  folderName?: string;
  recordingSessionId?: string;
  folderPath?: string;
  status: NativeStallDiagnosticsReceiptStatus;
  runId?: string;
  message?: string;
  lastArmed?: NativeStallDiagnosticsArmedRecording;
}

export type NativeStallDiagnosticsOutcome =
  | { runId: string | null }
  | { message: string };

export type NativeStallDiagnosticsPhase =
  | "off"
  | "waiting-for-recording"
  | "arming"
  | "armed"
  | "failed";

export interface NativeStallDiagnosticsProjection {
  phase: NativeStallDiagnosticsPhase;
  // Present in the armed phase only.
  runId?: string;
  // Present in the failed phase only.
  message?: string;
  // `<recording folder path>/diagnostics/native-stall`, derived from the path
  // captured in the receipt. No IPC and no file scan stand behind it.
  evidencePath?: string;
  evidenceOwner?: "current-recording" | "last-armed-recording";
}

export function nativeStallDiagnosticsEvidencePath(
  folderPath: string | undefined
): string | undefined {
  return folderPath
    ? `${folderPath}/${NATIVE_STALL_DIAGNOSTICS_EVIDENCE_SUBPATH}`
    : undefined;
}

// The pending receipt of one request, with the recording identity captured at
// enqueue. An arming request names the folder it asks native to arm; the
// session id and the path are taken only when the manager holds that folder.
// A disarm request names the recording it was issued in, if there is one.
export function createNativeStallDiagnosticsRequest(input: {
  requestId: number;
  enabled: boolean;
  folderName?: string;
  recording?: NativeStallDiagnosticsRecording | null;
}): NativeStallDiagnosticsReceipt {
  const recording = input.recording ?? undefined;
  const folderName = input.enabled ? input.folderName : recording?.folderName;
  const held =
    folderName !== undefined && recording?.folderName === folderName
      ? recording
      : undefined;
  return {
    requestId: input.requestId,
    enabled: input.enabled,
    ...(folderName !== undefined ? { folderName } : {}),
    ...(held?.sessionId !== undefined
      ? { recordingSessionId: held.sessionId }
      : {}),
    ...(held?.folderPath !== undefined ? { folderPath: held.folderPath } : {}),
    status: "pending",
  };
}

// First writer: the receipt kept once a request is enqueued. `settingEnabled`
// is the switch as of this request. It decides one thing: a disarm issued while
// the switch is off forgets the last armed recording for good, so turning the
// switch on again does not bring its folder back.
export function beginNativeStallDiagnosticsRequest(
  previous: NativeStallDiagnosticsReceipt | null,
  request: NativeStallDiagnosticsReceipt,
  settingEnabled: boolean
): NativeStallDiagnosticsReceipt {
  if (request.enabled || !settingEnabled) return request;
  const lastArmed: NativeStallDiagnosticsArmedRecording | undefined =
    previous?.enabled &&
    previous.status === "armed" &&
    previous.runId !== undefined &&
    previous.folderName !== undefined
      ? {
          folderName: previous.folderName,
          ...(previous.recordingSessionId !== undefined
            ? { recordingSessionId: previous.recordingSessionId }
            : {}),
          ...(previous.folderPath !== undefined
            ? { folderPath: previous.folderPath }
            : {}),
          runId: previous.runId,
        }
      : previous?.lastArmed;
  return lastArmed ? { ...request, lastArmed } : request;
}

// Second writer: the native reply, applied only to the pending receipt of the
// same request. The caller has already compared the request id with the
// counter; a reply for any other request leaves the receipt as it is.
export function settleNativeStallDiagnosticsRequest(
  previous: NativeStallDiagnosticsReceipt | null,
  requestId: number,
  outcome: NativeStallDiagnosticsOutcome
): NativeStallDiagnosticsReceipt | null {
  if (
    !previous ||
    previous.requestId !== requestId ||
    previous.status !== "pending"
  ) {
    return previous;
  }
  if ("message" in outcome) {
    return { ...previous, status: "failed", message: outcome.message };
  }
  if (!previous.enabled) return { ...previous, status: "disarmed" };
  if (typeof outcome.runId === "string" && outcome.runId.length > 0) {
    return { ...previous, status: "armed", runId: outcome.runId };
  }
  return {
    ...previous,
    status: "failed",
    message: NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE,
  };
}

// Whether the recording the manager holds now is the one captured when the
// request was enqueued. A request enqueued outside a recording matches none.
export function isNativeStallDiagnosticsRequestRecording(
  request: Pick<
    NativeStallDiagnosticsReceipt,
    "folderName" | "recordingSessionId"
  >,
  recording: NativeStallDiagnosticsRecording | null | undefined
): boolean {
  return (
    request.folderName !== undefined &&
    request.recordingSessionId !== undefined &&
    recording?.folderName === request.folderName &&
    recording.sessionId === request.recordingSessionId
  );
}

// What the panel shows. The setting is user intent; only a settled receipt for
// the current recording folder is shown as armed or failed.
export function projectNativeStallDiagnostics(input: {
  settingEnabled: boolean;
  recordingActive: boolean;
  folderName?: string;
  receipt: NativeStallDiagnosticsReceipt | null;
}): NativeStallDiagnosticsProjection {
  if (!input.settingEnabled) return { phase: "off" };
  const receipt = input.receipt;
  if (!input.recordingActive || !input.folderName) {
    // The disarm requests that follow Stop carry the armed recording forward;
    // until they are enqueued the armed receipt itself is that recording.
    const lastArmed =
      receipt?.lastArmed ??
      (receipt?.enabled &&
      receipt.status === "armed" &&
      receipt.runId !== undefined
        ? receipt
        : undefined);
    const evidencePath = nativeStallDiagnosticsEvidencePath(
      lastArmed?.folderPath
    );
    return evidencePath
      ? {
          phase: "waiting-for-recording",
          evidencePath,
          evidenceOwner: "last-armed-recording",
        }
      : { phase: "waiting-for-recording" };
  }
  if (
    !receipt ||
    !receipt.enabled ||
    receipt.folderName !== input.folderName ||
    receipt.status === "pending"
  ) {
    return { phase: "arming" };
  }
  if (receipt.status === "armed" && receipt.runId !== undefined) {
    const evidencePath = nativeStallDiagnosticsEvidencePath(receipt.folderPath);
    return evidencePath
      ? {
          phase: "armed",
          runId: receipt.runId,
          evidencePath,
          evidenceOwner: "current-recording",
        }
      : { phase: "armed", runId: receipt.runId };
  }
  if (receipt.status === "failed") {
    return { phase: "failed", message: receipt.message ?? "" };
  }
  // A settled arming request without a run id. The second writer never
  // produces it; it is still not armed and nothing is pending.
  return { phase: "failed", message: NATIVE_STALL_DIAGNOSTICS_NO_RUN_ID_MESSAGE };
}
