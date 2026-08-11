import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Database,
  EyeOff,
  FolderOpen,
  Info,
  PanelTop,
  ShieldCheck,
} from "lucide-react";
import {
  isTauriRuntime,
  revealCallRecordingsRoot,
  type MossInterfaceMode,
} from "@/lib/calling";
import "./settings.css";

interface AppSettingsPageProps {
  interfaceMode: MossInterfaceMode;
  nativeRuntimeAvailable: boolean;
  visibilityShortcut: string;
  onSwitchMode: (mode: MossInterfaceMode) => Promise<void>;
  onHide: () => Promise<void>;
}

export default function AppSettingsPage({
  interfaceMode,
  nativeRuntimeAvailable,
  visibilityShortcut,
  onSwitchMode,
  onHide,
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

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (success) setMessage(success);
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
          <p>Window behavior, local evidence, and privacy boundaries remain separate from realtime model guidance.</p>
        </div>
      </header>

      <div className="app-setting-list">
        <section className="app-setting-row">
          <span className="field-icon"><ShieldCheck size={17} /></span>
          <div>
            <h3>Privacy boundary</h3>
            <p>Audio is transcribed through the configured STT route. Runtime and Advisor prompts use their configured endpoints. MOSS retains event evidence locally and does not retain raw audio.</p>
          </div>
          <span className="setting-value">Local evidence</span>
        </section>

        <section className="app-setting-row">
          <span className="field-icon"><Database size={17} /></span>
          <div>
            <h3>Call recordings</h3>
            <p>Each session stores a status projection, append-only event log, and a manifest after a successful close.</p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void run("storage", revealCallRecordingsRoot, "Opened the recordings folder.")}
            disabled={busy !== null || !nativeRuntimeAvailable}
            title={nativeRuntimeAvailable ? undefined : "Available in the desktop app"}
          >
            <FolderOpen size={15} />
            Open folder
          </button>
        </section>

        <section className="app-setting-row">
          <span className="field-icon"><PanelTop size={17} /></span>
          <div>
            <h3>Window mode</h3>
            <p>Control mode manages configuration. Companion mode stays above other windows and keeps only realtime call controls.</p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void run(
              "mode",
              () => onSwitchMode(interfaceMode === "control" ? "companion" : "control")
            )}
            disabled={busy !== null}
          >
            {interfaceMode === "control" ? "Open companion" : "Open control"}
          </button>
        </section>

        <section className="app-setting-row">
          <span className="field-icon"><EyeOff size={17} /></span>
          <div>
            <h3>Dock-hidden operation</h3>
            <p>MOSS runs as an accessory app. Restore a hidden window with <kbd className="inline-shortcut">{visibilityShortcut}</kbd>.</p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void run("hide", onHide)}
            disabled={busy !== null || !nativeRuntimeAvailable}
            title={nativeRuntimeAvailable ? undefined : "Available in the desktop app"}
          >
            Hide MOSS
          </button>
        </section>

      </div>

      {(message || error) && (
        <div className={error ? "settings-message settings-error" : "settings-message"} role={error ? "alert" : "status"}>
          {error ?? message}
        </div>
      )}

      <div className="settings-footnote">
        <Info size={14} />
        Configuration pages never enter the model prompt and switching window modes does not start a model request.
      </div>
    </section>
  );
}
