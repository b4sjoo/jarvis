import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudioRecorder } from "../../src/pages/chats/components/AudioRecorder";

const fixture = (window as any).__audioFormat = {
  constraints: [] as unknown[], checked: [] as string[], chunks: [] as Blob[],
  requests: [] as any[], actualMime: "", transcript: "", error: "", stopped: false,
};
const context = new AudioContext();
const oscillator = context.createOscillator();
const destination = context.createMediaStreamDestination();
oscillator.connect(destination);
oscillator.start();
Object.defineProperty(navigator, "mediaDevices", { value: {
  getUserMedia: async (constraints: unknown) => {
    fixture.constraints.push(constraints);
    await context.resume();
    return destination.stream;
  },
} });
const NativeRecorder = window.MediaRecorder;
window.MediaRecorder = class extends NativeRecorder {
  static isTypeSupported(type: string) { fixture.checked.push(type); return NativeRecorder.isTypeSupported(type); }
  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super(stream, options);
    this.addEventListener("dataavailable", (event) => {
      fixture.actualMime = this.mimeType;
      if (event.data.size) fixture.chunks.push(event.data);
    });
    this.addEventListener("stop", () => { fixture.stopped = true; });
  }
};
window.fetch = async (url, options) => {
  if (url !== "https://stt.invalid/transcribe") throw new Error(`Unexpected network request: ${url}`);
  const file = (options!.body as FormData).get("file") as File;
  fixture.requests.push({
    type: file.type, name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())],
    capturedBytes: [...new Uint8Array(await new Blob(fixture.chunks).arrayBuffer())],
    stopped: fixture.stopped,
  });
  return new Response('{"text":"synthetic recording transcript"}');
};
function Fixture() {
  const [recording, setRecording] = useState(true);
  return recording ? <AudioRecorder onTranscriptionComplete={(text) => {
    fixture.transcript = text; setRecording(false); oscillator.stop(); void context.close();
  }} onCancel={() => { setRecording(false); oscillator.stop(); void context.close(); }}
    onError={(error) => { fixture.error = error; }} /> : <p>{fixture.transcript || fixture.error}</p>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
