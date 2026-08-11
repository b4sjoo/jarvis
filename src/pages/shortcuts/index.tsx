import { useEffect, useState } from "react";
import { Command, RotateCcw, Save, ShieldAlert } from "lucide-react";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  SHORTCUT_ACTION_LABELS,
  type ShortcutAction,
  type ShortcutSettings,
} from "@/lib/calling";
import "./shortcuts.css";

interface ShortcutPageProps {
  settings: ShortcutSettings;
  registrationError: string | null;
  lastAction: string | null;
  onSave: (settings: ShortcutSettings) => Promise<void>;
}

const actions = Object.keys(SHORTCUT_ACTION_LABELS) as ShortcutAction[];

export default function ShortcutSettingsPage({
  settings,
  registrationError,
  lastAction,
  onSave,
}: ShortcutPageProps) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(structuredClone(settings));
  }, [settings]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await onSave(draft);
      setMessage(`Shortcuts saved as revision ${settings.revision + 1}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-page shortcuts-page" aria-labelledby="shortcuts-title">
      <header className="settings-page-header">
        <div>
          <span className="settings-eyebrow">Global controls</span>
          <h2 id="shortcuts-title">Shortcuts</h2>
          <p>
            These actions call the same runtime commands as visible controls.
            Use modifier-heavy combinations to avoid accidental activation in other apps.
          </p>
        </div>
        <span className="settings-revision">Revision {settings.revision}</span>
      </header>

      <div className="settings-notice shortcut-notice">
        <ShieldAlert size={18} />
        <div>
          <strong>Text editing protection is active inside MOSS.</strong>
          <span>Listening, guidance, and end-call shortcuts are ignored while an input, textarea, or selector has focus.</span>
        </div>
      </div>

      <div className="shortcut-list">
        {actions.map((action) => (
          <label className="shortcut-row" key={action}>
            <span className="shortcut-icon"><Command size={16} /></span>
            <span className="shortcut-copy">
              <strong>{SHORTCUT_ACTION_LABELS[action]}</strong>
              <small>{action}</small>
            </span>
            <input
              value={draft.bindings[action]}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  bindings: {
                    ...current.bindings,
                    [action]: event.target.value,
                  },
                }))
              }
              spellCheck={false}
              autoCapitalize="off"
              aria-label={`${SHORTCUT_ACTION_LABELS[action]} shortcut`}
            />
          </label>
        ))}
      </div>

      {(registrationError || error || message || lastAction) && (
        <div
          className={registrationError || error ? "settings-message settings-error" : "settings-message"}
          role={registrationError || error ? "alert" : "status"}
        >
          {error ?? registrationError ?? message ?? lastAction}
        </div>
      )}

      <footer className="settings-actions">
        <button
          className="secondary-button"
          onClick={() => {
            setDraft({
              ...structuredClone(DEFAULT_SHORTCUT_SETTINGS),
              revision: settings.revision,
            });
            setMessage(null);
            setError(null);
          }}
          disabled={saving}
        >
          <RotateCcw size={15} />
          Use defaults
        </button>
        <button className="primary-button" onClick={() => void save()} disabled={saving}>
          <Save size={16} />
          {saving ? "Registering" : "Save shortcuts"}
        </button>
      </footer>
    </section>
  );
}
