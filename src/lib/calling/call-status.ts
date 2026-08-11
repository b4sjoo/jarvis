import type { CallSessionState } from "./types.js";

export const CALL_STATUS_LABELS: Record<CallSessionState, string> = {
  planned: "Ready",
  starting: "Starting",
  live: "Listening",
  paused: "Paused",
  recovering: "Recovering",
  closing: "Ending",
  closed: "Ended",
  "start-failed": "Start failed",
  "close-failed": "Close failed",
  abandoned: "Abandoned",
};

export function callStatusLabel(state: CallSessionState) {
  return CALL_STATUS_LABELS[state];
}
