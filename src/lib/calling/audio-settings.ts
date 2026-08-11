import { invoke } from "@tauri-apps/api/core";

export type AudioProfile = "quiet" | "balanced" | "sensitive" | "custom";

export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_duration_ms: number;
  minimum_speech_duration_ms: number;
  pre_speech_duration_ms: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

export interface AudioSettings {
  revision: number;
  profile: AudioProfile;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  vadConfig: VadConfig;
}

export interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012,
  peak_threshold: 0.035,
  silence_duration_ms: 1_045,
  minimum_speech_duration_ms: 163,
  pre_speech_duration_ms: 279,
  noise_gate_threshold: 0.003,
  max_recording_duration_secs: 180,
};

export const AUDIO_PROFILE_VALUES: Record<
  Exclude<AudioProfile, "custom">,
  Pick<
    VadConfig,
    "sensitivity_rms" | "noise_gate_threshold" | "silence_duration_ms"
  >
> = {
  quiet: {
    sensitivity_rms: 0.015,
    noise_gate_threshold: 0.005,
    silence_duration_ms: 1_277,
  },
  balanced: {
    sensitivity_rms: 0.012,
    noise_gate_threshold: 0.003,
    silence_duration_ms: 1_045,
  },
  sensitive: {
    sensitivity_rms: 0.008,
    noise_gate_threshold: 0.002,
    silence_duration_ms: 813,
  },
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  revision: 1,
  profile: "balanced",
  inputDeviceId: null,
  outputDeviceId: null,
  vadConfig: DEFAULT_VAD_CONFIG,
};

const STORAGE_KEY = "moss.audio-settings.v1";

const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const optionalDeviceId = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function normalizeVadConfig(value: unknown): VadConfig {
  const input = (value ?? {}) as Partial<VadConfig>;
  return {
    enabled: input.enabled !== false,
    hop_size: Math.round(
      clamp(finite(input.hop_size, DEFAULT_VAD_CONFIG.hop_size), 1, 16_384)
    ),
    sensitivity_rms: clamp(
      finite(input.sensitivity_rms, DEFAULT_VAD_CONFIG.sensitivity_rms),
      0,
      1
    ),
    peak_threshold: clamp(
      finite(input.peak_threshold, DEFAULT_VAD_CONFIG.peak_threshold),
      0,
      1
    ),
    silence_duration_ms: Math.round(
      clamp(
        finite(
          input.silence_duration_ms,
          DEFAULT_VAD_CONFIG.silence_duration_ms
        ),
        100,
        10_000
      )
    ),
    minimum_speech_duration_ms: Math.round(
      clamp(
        finite(
          input.minimum_speech_duration_ms,
          DEFAULT_VAD_CONFIG.minimum_speech_duration_ms
        ),
        50,
        5_000
      )
    ),
    pre_speech_duration_ms: Math.round(
      clamp(
        finite(
          input.pre_speech_duration_ms,
          DEFAULT_VAD_CONFIG.pre_speech_duration_ms
        ),
        0,
        5_000
      )
    ),
    noise_gate_threshold: clamp(
      finite(
        input.noise_gate_threshold,
        DEFAULT_VAD_CONFIG.noise_gate_threshold
      ),
      0,
      1
    ),
    max_recording_duration_secs: Math.round(
      clamp(
        finite(
          input.max_recording_duration_secs,
          DEFAULT_VAD_CONFIG.max_recording_duration_secs
        ),
        1,
        3_600
      )
    ),
  };
}

export function applyAudioProfile(
  config: VadConfig,
  profile: Exclude<AudioProfile, "custom">
) {
  return normalizeVadConfig({ ...config, ...AUDIO_PROFILE_VALUES[profile] });
}

export function normalizeAudioSettings(value: unknown): AudioSettings {
  const input = (value ?? {}) as Partial<AudioSettings>;
  const profile: AudioProfile = [
    "quiet",
    "balanced",
    "sensitive",
    "custom",
  ].includes(input.profile ?? "")
    ? (input.profile as AudioProfile)
    : "balanced";
  return {
    revision: Math.max(1, Math.round(finite(input.revision, 1))),
    profile,
    inputDeviceId: optionalDeviceId(input.inputDeviceId),
    outputDeviceId: optionalDeviceId(input.outputDeviceId),
    vadConfig: normalizeVadConfig(input.vadConfig),
  };
}

export function loadAudioSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored
      ? normalizeAudioSettings(JSON.parse(stored))
      : structuredClone(DEFAULT_AUDIO_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_AUDIO_SETTINGS);
  }
}

export function persistAudioSettings(settings: AudioSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export async function loadAudioDevices() {
  if (!("__TAURI_INTERNALS__" in window)) {
    return { input: [] as AudioDevice[], output: [] as AudioDevice[] };
  }
  const [input, output] = await Promise.all([
    invoke<AudioDevice[]>("get_input_devices"),
    invoke<AudioDevice[]>("get_output_devices"),
  ]);
  return { input, output };
}

export async function updateNativeVadConfig(config: VadConfig) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  await invoke("update_vad_config", { config });
}
