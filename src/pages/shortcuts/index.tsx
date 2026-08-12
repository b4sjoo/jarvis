import { Command, ShieldCheck } from "lucide-react";
import {
  FIXED_SHORTCUT_DEFINITIONS,
  shortcutDisplayParts,
} from "@/lib/calling";
import "./shortcuts.css";

interface ShortcutPageProps {
  registrationError: string | null;
  lastAction: string | null;
}

export default function ShortcutReferencePage({
  registrationError,
  lastAction,
}: ShortcutPageProps) {
  return (
    <section className="settings-page shortcuts-page" aria-labelledby="shortcuts-title">
      <header className="settings-page-header">
        <div>
          <span className="settings-eyebrow">Global controls</span>
          <h2 id="shortcuts-title">Shortcuts</h2>
          <p>
            MOSS uses a fixed shortcut set so controls remain predictable across
            calls. Visible buttons and shortcuts invoke the same runtime commands.
          </p>
        </div>
      </header>

      <div className="settings-notice shortcut-notice">
        <ShieldCheck size={18} />
        <div>
          <strong>Call actions are protected while you edit.</strong>
          <span>
            Listening, guidance, and end-call shortcuts are ignored while an
            input, textarea, or selector has focus.
          </span>
        </div>
      </div>

      <div className="shortcut-list">
        {FIXED_SHORTCUT_DEFINITIONS.map((definition) => (
          <div className="shortcut-row" key={definition.action}>
            <span className="shortcut-icon" aria-hidden="true">
              <Command size={17} />
            </span>
            <span className="shortcut-copy">
              <strong>{definition.label}</strong>
              <small>{definition.description}</small>
            </span>
            <span
              className="shortcut-keycaps"
              aria-label={`${definition.label}: ${shortcutDisplayParts(
                definition.action
              ).join(" plus ")}`}
            >
              {shortcutDisplayParts(definition.action).map((part) => (
                <kbd key={part}>{part}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>

      {(registrationError || lastAction) && (
        <div
          className={
            registrationError
              ? "settings-message settings-error"
              : "settings-message"
          }
          role={registrationError ? "alert" : "status"}
        >
          {registrationError ?? lastAction}
        </div>
      )}
    </section>
  );
}
