import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/pages/app";
import { AudioRecorder } from "../../src/pages/chats/components/AudioRecorder";
import { ChatAudio } from "../../src/pages/chats/components/ChatAudio";
import { ChatScreenshot } from "../../src/pages/chats/components/ChatScreenshot";

const fixture = (window as any).__audioRetirement = {
  calls: [] as any[], listeners: [] as string[], unlistened: [] as string[],
  titles: 0, intervals: 0, timeouts: 0, tracksStopped: 0, contextsClosed: 0,
  frames: 0, screenshots: 0, constraints: [] as any[], stt: [] as any[],
  storageCalls: [] as any[], managed: false, failStt: false, transcripts: [] as string[],
  cancellations: 0,
};
fixture.context = {
  customizable: { cursor: { type: "default" } },
  selectedSttProvider: { provider: "fixture-stt", variables: { language: "en" } },
  allSttProviders: [{ id: "fixture-stt", name: "Fixture STT" }],
  selectedAudioDevices: { input: { id: "fixture-microphone" } },
  supportsImages: true, managedApiEnabled: false,
};
const initialStorage = {
  system_audio_context: '{"enabled":true,"contextContent":"unused"}',
  system_audio_quick_actions: '["old action"]',
  vad_config: '{"enabled":true}',
  chat_history: '[{"id":"untouched"}]',
  meeting_assistant_settings: '{"fixture":true}',
};
for (const [key, value] of Object.entries(initialStorage)) localStorage.setItem(key, value);
fixture.storageBefore = JSON.stringify({ ...localStorage });
for (const method of ["getItem", "setItem", "removeItem", "clear"] as const) {
  const original = Storage.prototype[method];
  (Storage.prototype as any)[method] = function (...args: any[]) {
    fixture.storageCalls.push([method, ...args]);
    return (original as any).apply(this, args);
  };
}
const originalInterval = window.setInterval.bind(window);
window.setInterval = ((...args: any[]) => {
  fixture.intervals++;
  return (originalInterval as any)(...args);
}) as typeof window.setInterval;
const originalTimeout = window.setTimeout.bind(window);
window.setTimeout = ((...args: any[]) => {
  fixture.timeouts++;
  return (originalTimeout as any)(...args);
}) as typeof window.setTimeout;

// All device/encoding boundaries are fixtures; the production recorder and
// visualizer still own start, send, provider selection and cleanup.
const track = { enabled: true, stop() { fixture.tracksStopped++; } };
const stream = { getTracks: () => [track] };
Object.defineProperty(navigator, "mediaDevices", { value: {
  getUserMedia: async (constraints: any) => { fixture.constraints.push(constraints); return stream; },
} });
class FixtureRecorder {
  static isTypeSupported(type: string) { return type === "audio/webm"; }
  state = "inactive";
  mimeType: string;
  ondataavailable?: (event: any) => void;
  constructor(_stream: any, options: any) { this.mimeType = options.mimeType; }
  start() {
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob(["fixture audio"], { type: this.mimeType }) });
  }
  stop() { this.state = "inactive"; }
}
(window as any).MediaRecorder = FixtureRecorder;
(window as any).AudioContext = class {
  createAnalyser() { return {
    frequencyBinCount: 8,
    getByteFrequencyData(data: Uint8Array) { fixture.frames++; data.fill(128); },
  }; }
  createMediaStreamSource(received: any) {
    if (received !== stream) throw new Error("Visualizer did not receive the recording stream");
    return { connect() {} };
  }
  createOscillator() { throw new Error("Chat must visualize its real supplied stream"); }
  close() { fixture.contextsClosed++; }
};

function ChatFixture() {
  const [recording, setRecording] = useState(false);
  const [micOpen, setMicOpen] = useState(false);
  const [text, setText] = useState("");
  return <section>
    <ChatAudio micOpen={micOpen} setMicOpen={setMicOpen} isRecording={recording}
      setIsRecording={setRecording} disabled={false} />
    {recording && <AudioRecorder onTranscriptionComplete={(value) => {
      fixture.transcripts.push(value); setText(value); setRecording(false);
    }} onCancel={() => { fixture.cancellations++; setRecording(false); }} />}
    <textarea aria-label="Chat text" value={text} onChange={(event) => setText(event.target.value)} />
    <ChatScreenshot screenshotConfiguration={{ enabled: true, mode: "manual" }}
      attachedFiles={[]} isLoading={false} isScreenshotLoading={false} disabled={false}
      captureScreenshot={async () => { fixture.screenshots++; }} />
  </section>;
}

const root = createRoot(document.getElementById("root")!);
fixture.showApp = () => root.render(<App />);
fixture.showChat = () => root.render(<ChatFixture />);
fixture.unmount = () => root.unmount();
fixture.showApp();
