import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EyeOff, Info, ShieldCheck } from "lucide-react";
import { isTauriRuntime } from "@/lib/calling";
import "./settings.css";

interface AppSettingsPageProps {
  nativeRuntimeAvailable: boolean;
  stealthMode: boolean;
  onSetStealthMode: (enabled: boolean) => Promise<void>;
}

export default function AppSettingsPage({
  nativeRuntimeAvailable,
  stealthMode,
  onSetStealthMode,
}: AppSettingsPageProps) {
  const [version, setVersion] = useState("0.1.0");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isTauriRuntime()) {
      void invoke<string>("get_app_version").then(setVersion).catch(() => undefined);
    }
  }, []);

  const toggleStealthMode = async () => {
    const enabled = !stealthMode;
    setBusy("stealth-mode");
    setError(null);
    setMessage(null);
    try {
      await onSetStealthMode(enabled);
      setMessage(
        enabled
          ? "Stealth Mode enabled. MOSS is hidden from Dock and Cmd-Tab."
          : "Stealth Mode disabled. MOSS is visible in Dock and Cmd-Tab."
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-page app-settings-page" aria-labelledby="app-settings-title">
      <header className="settings-page-header">
        <div>
          <span className="settings-eyebrow">MOSS {version}</span>
          <h2 id="app-settings-title">Application settings</h2>
          <p>Privacy and desktop visibility remain separate from realtime model guidance.</p>
        </div>
      </header>

      <div className="app-setting-list">
        <section className="app-setting-row">
          <span className="field-icon"><ShieldCheck size={17} /></span>
          <div>
            <h3>Privacy boundary</h3>
            <p>Audio is transcribed through the configured STT route. Runtime and Advisor prompts use their selected providers. MOSS retains event evidence locally and does not retain raw audio.</p>
          </div>
          <span className="setting-value">Local evidence</span>
        </section>

        <section className="app-setting-row">
          <span className="field-icon"><EyeOff size={17} /></span>
          <div>
            <h3>Stealth Mode</h3>
            <p>Hide the MOSS icon from Dock and Cmd-Tab. The fixed show/hide shortcut remains available.</p>
          </div>
          <label
            className={`setting-switch${!nativeRuntimeAvailable ? " setting-switch-disabled" : ""}`}
            title={nativeRuntimeAvailable ? undefined : "Available in the desktop app"}
          >
            <input
              type="checkbox"
              role="switch"
              aria-label="Stealth Mode"
              checked={stealthMode}
              onChange={() => void toggleStealthMode()}
              disabled={busy !== null || !nativeRuntimeAvailable}
            />
            <span className="setting-switch-track" aria-hidden="true"><span /></span>
            <span className="setting-value">{stealthMode ? "On" : "Off"}</span>
          </label>
        </section>

      </div>

      {(message || error) && (
        <div className={error ? "settings-message settings-error" : "settings-message"} role={error ? "alert" : "status"}>
          {error ?? message}
        </div>
      )}

      <div className="settings-footnote">
        <Info size={14} />
        Application settings stay local and never enter a model prompt.
      </div>
    </section>
  );
}
