import { Header, Input, Button } from "@/components";
import { useEffect, useState } from "react";
import { useApp } from "@/contexts";
import { TrashIcon } from "lucide-react";
import { DECISIONS_MODEL, DECISIONS_PROVIDER_ID, readDecisionsProviderConfiguration } from "@/config/decisions.constants";

export function DecisionsProvider() {
  const { selectedDecisionsProvider, onSetSelectedDecisionsProvider } = useApp();
  const key = selectedDecisionsProvider?.variables?.api_key ?? "";
  const [draft, setDraft] = useState(key);
  const [saveError, setSaveError] = useState<string>();
  useEffect(() => { setDraft(key); }, [key]);
  const { error } = readDecisionsProviderConfiguration(selectedDecisionsProvider);
  const setKey = (apiKey: string) => {
    setDraft(apiKey);
    setSaveError(onSetSelectedDecisionsProvider({ provider: DECISIONS_PROVIDER_ID,
      variables: { model: DECISIONS_MODEL, api_key: apiKey } }));
  };
  return (
    <section id="decisions-provider" className="min-w-0 space-y-3">
      <Header title="Decisions Provider" description="OpenAI" isMainTitle />
      <div className="space-y-1">
        <label htmlFor="decisions-model" className="text-sm font-medium">Model</label>
        <Input id="decisions-model" value={DECISIONS_MODEL} readOnly className="h-11" />
      </div>
      <div className="space-y-1">
        <label htmlFor="decisions-api-key" className="text-sm font-medium">API Key</label>
        <div className="flex min-w-0 gap-2">
          <Input id="decisions-api-key" type="password" placeholder="OpenAI API key"
            value={draft} onChange={event => setKey(event.target.value)}
            className="h-11 min-w-0 flex-1 border-1 border-input/50 transition-colors focus:border-primary/50" />
          {draft.trim() ? <Button size="icon" variant="destructive" className="h-11 w-11 shrink-0" title="Remove API Key"
            aria-label="Remove Decisions API key" onClick={() => setKey("")}>
            <TrashIcon className="h-4 w-4" />
          </Button> : null}
        </div>
      </div>
      {saveError ? <p role="alert" className="text-xs text-red-500">{saveError}</p>
        : error ? <p role="status" className="text-xs text-muted-foreground">{error}</p> : null}
    </section>
  );
}
