export interface RecordingCloseState {
  callSessionId: string;
  recordingPath: string;
  state: "open" | "closing" | "closed" | "close-failed" | "abandoned";
  attempt: number;
  pendingEventCount: number;
  lastError?: string;
}

export type RecordingCloseCommand =
  | { type: "request-close" }
  | { type: "close-succeeded" }
  | { type: "close-failed"; error: string }
  | { type: "retry-close" }
  | { type: "abandon" };

export function reduceRecordingClose(
  state: RecordingCloseState,
  command: RecordingCloseCommand
): RecordingCloseState {
  switch (command.type) {
    case "request-close":
      if (state.state !== "open") throw new Error("Recording is not open.");
      return { ...state, state: "closing", attempt: state.attempt + 1 };
    case "close-succeeded":
      if (state.state !== "closing") throw new Error("Recording is not closing.");
      return { ...state, state: "closed", pendingEventCount: 0, lastError: undefined };
    case "close-failed":
      if (state.state !== "closing") throw new Error("Recording is not closing.");
      return { ...state, state: "close-failed", lastError: command.error };
    case "retry-close":
      if (state.state !== "close-failed") throw new Error("Recording close is not retryable.");
      return { ...state, state: "closing", attempt: state.attempt + 1 };
    case "abandon":
      if (state.state !== "close-failed") throw new Error("Only failed close can be abandoned.");
      return { ...state, state: "abandoned" };
  }
}
