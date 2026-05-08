import { invoke } from "@tauri-apps/api/core";
import { ScreenObservation } from "./types";
import { createMeetingId } from "./context-manager";

export interface CaptureScreenObservationOptions {
  source?: ScreenObservation["source"];
  previousHash?: string;
}

export async function captureScreenObservation({
  source = "hotkey",
  previousHash,
}: CaptureScreenObservationOptions = {}): Promise<ScreenObservation> {
  const imageBase64 = await invoke<string>("capture_to_base64");
  const hash = hashBase64(imageBase64);

  return {
    id: createMeetingId("screen"),
    capturedAt: Date.now(),
    source,
    imageBase64,
    hash,
    changed: hash !== previousHash,
  };
}

export function hashBase64(value: string) {
  let hash = 0;
  const stride = Math.max(1, Math.floor(value.length / 2048));

  for (let index = 0; index < value.length; index += stride) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `${value.length}_${Math.abs(hash)}`;
}

