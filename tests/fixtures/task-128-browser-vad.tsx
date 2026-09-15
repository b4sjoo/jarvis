import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AutoSpeechVAD } from "../../src/pages/app/components/completion/AutoSpeechVad";
import { useBrowserMicrophoneVad } from "../../src/hooks/useBrowserMicrophoneVad";

const f = (window as any).__browserVad = {
  constraints: [] as any[], tracks: [] as any[], contexts: [] as any[], nodes: [] as any[],
  stt: [] as any[], submissions: [] as string[], meAudio: [] as number[], observations: [] as any[],
  deferredMedia: [] as (() => void)[], delayMedia: false, error: "", ready: false,
  meCommits: [] as any[], nativeDrainPending: false,
};
Object.defineProperty(navigator, "mediaDevices", { value: {
  getUserMedia: (constraints: any) => {
    f.constraints.push(constraints);
    const track = Object.assign(new EventTarget(), {
      readyState: "live", muted: false,
      getSettings: () => ({ deviceId: constraints.audio.deviceId.exact }),
      stop() { this.readyState = "ended"; },
    });
    f.tracks.push(track);
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    return f.delayMedia ? new Promise((resolve) => { f.deferredMedia.push(() => resolve(stream)); }) : Promise.resolve(stream);
  },
} });
(window as any).AudioContext = class {
  state = "suspended";
  audioWorklet = { addModule: async () => {} };
  constructor() { f.contexts.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
};
(window as any).AudioWorkletNode = class {
  port = { onmessage: undefined as any, postMessage() {} };
  constructor() { f.nodes.push(this); }
  disconnect() {}
};
f.speech = async (index: number) => {
  const node = f.nodes[index];
  for (const probability of [0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0, 0, 0]) {
    await node.port.onmessage({ data: { message: "AUDIO_FRAME", data: new Float32Array(1536).fill(probability).buffer } });
  }
};
function MeProbe({ enabled, sessionKey, status }: { enabled: boolean; sessionKey: string; status: string }) {
  const options = { enabled, sessionKey, deviceId: "me-mic", userSpeakingThreshold: 0.6,
    onSpeechEnd: (audio) => { f.meAudio.push(audio.length); },
    onObservation: (event) => f.observations.push(event),
  } satisfies Parameters<typeof useBrowserMicrophoneVad>[0];
  const vad = useBrowserMicrophoneVad(options);
  f.meVad = vad;
  useEffect(() => {
    f.meCommits.push({ enabled, sessionKey, status, listening: vad.listening });
  });
  return <span data-me-listening={vad.listening} />;
}
function Fixture() {
  const [top, enableTop] = useState(false), [me, enableMe] = useState(false);
  const [device, setDevice] = useState("top-mic");
  const audioSessionIdRef = useRef("audio-session-initial");
  const [meState, setMeState] = useState({ status: "listening" });
  f.beginMeDrain = async () => {
    f.nativeDrainPending = true;
    await f.meVad.dispose();
  };
  f.resumeMe = (sessionId: string) => {
    audioSessionIdRef.current = sessionId;
    setMeState({ status: "listening" });
  };
  f.ready = true;
  return <>
    <button onClick={() => enableTop(true)}>Enable top</button>
    <button onClick={() => enableTop(false)}>Disable top</button>
    <button onClick={() => setDevice("replacement-mic")}>Replace top device</button>
    <button onClick={() => enableMe(true)}>Enable Me</button>
    <button onClick={() => enableMe(false)}>Disable Me</button>
    {top && <AutoSpeechVAD microphoneDeviceId={device} setEnableVAD={enableTop}
      submit={((text: string) => { f.submissions.push(text); }) as any}
      setState={((update: any) => { f.error = update({}).error; }) as any} />}
    <MeProbe enabled={me} sessionKey={audioSessionIdRef.current} status={meState.status} />
  </>;
}
const root = createRoot(document.getElementById("root")!);
f.unmount = () => root.unmount();
root.render(<Fixture />);
