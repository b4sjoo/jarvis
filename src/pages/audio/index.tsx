import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Mic,
  RefreshCw,
  RotateCcw,
  Speaker,
} from "lucide-react";
import type { CallingAssistantController } from "@/hooks/useCallingAssistant";
import MossSelect from "@/components/ui/MossSelect";
import {
  DEFAULT_VAD_CONFIG,
  applyAudioProfile,
  loadAudioDevices,
  type AudioDevice,
  type AudioProfile,
  type AudioSettings,
  type VadConfig,
} from "@/lib/calling";
import "./audio.css";

const profiles: Array<{
  id: Exclude<AudioProfile, "custom">;
  label: string;
  description: string;
}> = [
  { id: "quiet", label: "Quiet", description: "Reject more room noise." },
  { id: "balanced", label: "Balanced", description: "Recommended default." },
  { id: "sensitive", label: "Sensitive", description: "Catch softer speech." },
];

const blockedStates = new Set(["starting", "live", "recovering", "closing"]);

const updateVad = <K extends keyof VadConfig>(
  settings: AudioSettings,
  key: K,
  value: VadConfig[K]
): AudioSettings => ({
  ...settings,
  profile: "custom",
  vadConfig: { ...settings.vadConfig, [key]: value },
});

function DeviceSelect({
  icon,
  label,
  description,
  devices,
  value,
  onChange,
}: {
  icon: "microphone" | "speaker";
  label: string;
  description: string;
  devices: AudioDevice[];
  value: string | null;
  onChange: (deviceId: string | null) => void;
}) {
  const Icon = icon === "microphone" ? Mic : Speaker;
  return (
    <label className="device-field">
      <span className="field-icon"><Icon size={17} /></span>
      <span className="field-copy"><strong>{label}</strong><small>{description}</small></span>
      <MossSelect
        ariaLabel={`${label} device`}
        value={value ?? ""}
        onValueChange={(deviceId) => onChange(deviceId || null)}
        options={[
          { value: "", label: "System default" },
          ...devices.map((device) => ({
            value: device.id,
            label: `${device.name}${device.is_default ? " (Default)" : ""}`,
          })),
        ]}
      />
    </label>
  );
}

function RangeField({
  label,
  hint,
  value,
  display,
  minimum,
  maximum,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  display: string;
  minimum: number;
  maximum: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-field">
      <span><strong>{label}</strong><small>{hint}</small></span>
      <output>{display}</output>
      <input
        type="range"
        min={minimum}
        max={maximum}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export default function AudioSettingsPage({
  controller,
}: {
  controller: CallingAssistantController;
}) {
  const [draft, setDraft] = useState<AudioSettings>(() =>
    structuredClone(controller.audioSettings)
  );
  const [devices, setDevices] = useState<{
    input: AudioDevice[];
    output: AudioDevice[];
  }>({ input: [], output: [] });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = blockedStates.has(controller.runtime.state);

  useEffect(() => {
    setDraft(structuredClone(controller.audioSettings));
  }, [controller.audioSettings]);

  const refreshDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDevices(await loadAudioDevices());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await controller.saveAudioConfiguration(draft);
      setDraft(structuredClone(saved));
      setMessage(
        controller.runtime.state === "paused"
          ? "Audio settings will apply when listening resumes."
          : "Audio settings saved."
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page audio-settings-page">
      <section className="settings-section">
        <div className="settings-section-heading">
          <div><h2>Audio devices</h2><p>Choose the devices MOSS should use for this machine.</p></div>
          <button className="secondary-button" onClick={() => void refreshDevices()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
            Refresh
          </button>
        </div>
        <div className="device-list">
          <DeviceSelect
            icon="microphone"
            label="Microphone preference"
            description="Stored for microphone-side context. Task 0 currently transcribes counterparty system audio."
            devices={devices.input}
            value={draft.inputDeviceId}
            onChange={(inputDeviceId) => setDraft((current) => ({ ...current, inputDeviceId }))}
          />
          <DeviceSelect
            icon="speaker"
            label="Counterparty audio"
            description="The output device used for system-audio capture."
            devices={devices.output}
            value={draft.outputDeviceId}
            onChange={(outputDeviceId) => setDraft((current) => ({ ...current, outputDeviceId }))}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div><h2>Speech detection</h2><p>Start with a profile, then adjust advanced values only when a recording shows a problem.</p></div>
        </div>
        <div className="profile-control" role="radiogroup" aria-label="Speech detection profile">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              role="radio"
              aria-checked={draft.profile === profile.id}
              className={draft.profile === profile.id ? "profile-option profile-option-active" : "profile-option"}
              onClick={() => setDraft((current) => ({
                ...current,
                profile: profile.id,
                vadConfig: applyAudioProfile(current.vadConfig, profile.id),
              }))}
            >
              <strong>{profile.label}</strong>
              <small>{profile.description}</small>
            </button>
          ))}
        </div>

        <div className="advanced-audio">
          <div className="range-grid">
            <RangeField
              label="Speech sensitivity"
              hint="Lower values detect quieter speech."
              value={draft.vadConfig.sensitivity_rms * 1_000}
              display={(draft.vadConfig.sensitivity_rms * 1_000).toFixed(1)}
              minimum={2}
              maximum={30}
              step={0.5}
              onChange={(value) => setDraft((current) => updateVad(current, "sensitivity_rms", value / 1_000))}
            />
            <RangeField
              label="Silence duration"
              hint="How long MOSS waits before closing a turn."
              value={draft.vadConfig.silence_duration_ms}
              display={`${(draft.vadConfig.silence_duration_ms / 1_000).toFixed(2)} s`}
              minimum={300}
              maximum={3_000}
              step={25}
              onChange={(value) => setDraft((current) => updateVad(current, "silence_duration_ms", value))}
            />
            <RangeField
              label="Noise gate"
              hint="Higher values reject more low-level sound."
              value={draft.vadConfig.noise_gate_threshold * 1_000}
              display={(draft.vadConfig.noise_gate_threshold * 1_000).toFixed(1)}
              minimum={0}
              maximum={15}
              step={0.5}
              onChange={(value) => setDraft((current) => updateVad(current, "noise_gate_threshold", value / 1_000))}
            />
            <RangeField
              label="Minimum speech"
              hint="Reject shorter transients and clicks."
              value={draft.vadConfig.minimum_speech_duration_ms}
              display={`${draft.vadConfig.minimum_speech_duration_ms} ms`}
              minimum={50}
              maximum={1_500}
              step={25}
              onChange={(value) => setDraft((current) => updateVad(current, "minimum_speech_duration_ms", value))}
            />
            <RangeField
              label="Maximum segment"
              hint="Force a boundary during long uninterrupted speech."
              value={draft.vadConfig.max_recording_duration_secs}
              display={`${draft.vadConfig.max_recording_duration_secs} s`}
              minimum={30}
              maximum={300}
              step={15}
              onChange={(value) => setDraft((current) => updateVad(current, "max_recording_duration_secs", value))}
            />
          </div>
        </div>
      </section>

      {blocked && <div className="inline-notice warning-notice">Pause the call before applying audio changes. Browsing these settings does not interrupt capture.</div>}
      {message && <div className="inline-notice success-notice"><Check size={15} />{message}</div>}
      {error && <div className="inline-notice error-notice">{error}</div>}

      <div className="settings-actions">
        <button
          className="secondary-button"
          onClick={() => setDraft((current) => ({
            ...current,
            profile: "balanced",
            vadConfig: structuredClone(DEFAULT_VAD_CONFIG),
          }))}
        >
          <RotateCcw size={15} />
          Reset detection
        </button>
        <button className="primary-button" onClick={() => void save()} disabled={blocked || saving}>
          {saving ? "Saving..." : "Save audio settings"}
        </button>
      </div>
    </div>
  );
}
