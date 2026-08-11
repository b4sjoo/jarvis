import { useEffect, useState } from "react";
import { KeyRound, Save, Server, ShieldCheck } from "lucide-react";
import type {
  CallingAssistantController,
  CallingProviderSecrets,
} from "@/hooks/useCallingAssistant";
import {
  CHAT_PROVIDERS,
  STT_LANGUAGES,
  STT_PROVIDERS,
  getChatProvider,
  getSttProvider,
  type ChatProviderId,
  type ChatRouteId,
  type ModelRouteSettings,
  type SttProviderId,
} from "@/lib/calling";
import "./models.css";

const routeLabels: Record<ChatRouteId, string> = {
  runtime: "Runtime",
  advisor: "Advisor",
  complex: "Complex Task",
};

export default function ModelSettingsPage({
  controller,
}: {
  controller: CallingAssistantController;
}) {
  const [draft, setDraft] = useState<ModelRouteSettings>(() =>
    structuredClone(controller.settings)
  );
  const [secrets, setSecrets] = useState<CallingProviderSecrets>({
    runtime: "",
    advisor: "",
    complex: "",
    stt: "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(structuredClone(controller.settings));
  }, [controller.settings]);

  const updateChat = (
    route: ChatRouteId,
    model: string
  ) => {
    setDraft((current) => ({
      ...current,
      chat: {
        ...current.chat,
        [route]: { ...current.chat[route], model },
      },
    }));
  };

  const updateChatProvider = (
    route: ChatRouteId,
    provider: ChatProviderId
  ) => {
    setDraft((current) => ({
      ...current,
      chat: {
        ...current.chat,
        [route]: {
          ...current.chat[route],
          provider,
          endpoint: getChatProvider(provider).endpoint,
        },
      },
    }));
  };

  const updateSttProvider = (provider: SttProviderId) => {
    setDraft((current) => ({
      ...current,
      stt: {
        ...current.stt,
        provider,
        endpoint: getSttProvider(provider).endpoint,
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await controller.saveConfiguration(draft, secrets);
      setSecrets({ runtime: "", advisor: "", complex: "", stt: "" });
      setMessage(`Model routes saved as revision ${saved.revision}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-page models-page" aria-labelledby="models-title">
      <header className="settings-page-header">
        <div>
          <span className="settings-eyebrow">Model configuration</span>
          <h2 id="models-title">Independent model routes</h2>
          <p>
            Runtime settles narrow call intent, Advisor writes realtime guidance,
            Complex Task handles deliberate work, and STT transcribes audio.
          </p>
        </div>
        <span className="settings-revision">Revision {controller.settings.revision}</span>
      </header>

      <div className="settings-notice">
        <ShieldCheck size={18} />
        <div>
          <strong>Prompts remain versioned product contracts.</strong>
          <span>API keys are replaced only when a new value is entered and remain in the OS keychain.</span>
        </div>
      </div>

      <div className="model-route-grid">
        {(Object.keys(routeLabels) as ChatRouteId[]).map((route) => (
          <fieldset className="model-route" key={route}>
            <legend>
              <Server size={16} />
              {routeLabels[route]}
              <span className={controller.configured[route] ? "route-ready" : "route-missing"}>
                {controller.configured[route] ? "Ready" : "Key required"}
              </span>
            </legend>
            <label>
              Provider
              <select
                value={draft.chat[route].provider}
                onChange={(event) =>
                  updateChatProvider(route, event.target.value as ChatProviderId)
                }
              >
                {CHAT_PROVIDERS.map((provider) => (
                  <option value={provider.id} key={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <input
                value={draft.chat[route].model}
                onChange={(event) => updateChat(route, event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              API key
              <span className="secret-input">
                <KeyRound size={15} />
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    getChatProvider(draft.chat[route].provider).requiresApiKey
                      ? "Enter to replace"
                      : "Not required"
                  }
                  disabled={
                    !getChatProvider(draft.chat[route].provider).requiresApiKey
                  }
                  value={secrets[route]}
                  onChange={(event) =>
                    setSecrets((current) => ({
                      ...current,
                      [route]: event.target.value,
                    }))
                  }
                />
              </span>
            </label>
          </fieldset>
        ))}

        <fieldset className="model-route">
          <legend>
            <Server size={16} />
            Speech-to-Text
            <span className={controller.configured.stt ? "route-ready" : "route-missing"}>
              {controller.configured.stt ? "Ready" : "Key required"}
            </span>
          </legend>
          <label>
            Provider
            <select
              value={draft.stt.provider}
              onChange={(event) =>
                updateSttProvider(event.target.value as SttProviderId)
              }
            >
              {STT_PROVIDERS.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input
              value={draft.stt.model}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  stt: { ...current.stt, model: event.target.value },
                }))
              }
              spellCheck={false}
            />
          </label>
          <label>
            Language
            <select
              value={draft.stt.language}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  stt: { ...current.stt, language: event.target.value },
                }))
              }
            >
              {STT_LANGUAGES.map((language) => (
                <option value={language.code} key={language.code || "auto"}>
                  {language.flag} {language.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            API key
            <span className="secret-input">
              <KeyRound size={15} />
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  getSttProvider(draft.stt.provider).requiresApiKey
                    ? "Enter to replace"
                    : "Not required"
                }
                disabled={!getSttProvider(draft.stt.provider).requiresApiKey}
                value={secrets.stt}
                onChange={(event) =>
                  setSecrets((current) => ({
                    ...current,
                    stt: event.target.value,
                  }))
                }
              />
            </span>
          </label>
        </fieldset>
      </div>

      {(message || error) && (
        <div className={error ? "settings-message settings-error" : "settings-message"} role={error ? "alert" : "status"}>
          {error ?? message}
        </div>
      )}

      <footer className="settings-actions">
        <button
          className="secondary-button"
          onClick={() => {
            setDraft(structuredClone(controller.settings));
            setSecrets({ runtime: "", advisor: "", complex: "", stt: "" });
            setMessage(null);
            setError(null);
          }}
          disabled={saving}
        >
          Reset changes
        </button>
        <button className="primary-button" onClick={() => void save()} disabled={saving}>
          <Save size={16} />
          {saving ? "Saving" : "Save routes"}
        </button>
      </footer>
    </section>
  );
}
