import { Header, Input, Button } from "@/components";
import { useApp } from "@/contexts";
import { TrashIcon } from "lucide-react";
import { DECISIONS_MODEL, DECISIONS_PROVIDER_ID, readDecisionsProviderConfiguration } from "@/config/decisions.constants";

export function DecisionsProvider() {
  const { selectedDecisionsProvider, onSetSelectedDecisionsProvider } = useApp();
  const key = selectedDecisionsProvider?.variables?.api_key ?? "";
  const { error } = readDecisionsProviderConfiguration(selectedDecisionsProvider);
  const setKey = (apiKey: string) => onSetSelectedDecisionsProvider({
    provider: DECISIONS_PROVIDER_ID,
    variables: { model: DECISIONS_MODEL, api_key: apiKey },
  });
  return (
    <section id="decisions-provider" className="min-w-0 space-y-3">
      <Header title="Decisions Provider" description="OpenAI" isMainTitle />
      <div className="space-y-1">
        <label htmlFor="decisions-model" className="text-sm font-medium">Model</label>
        <Input id="decisions-model" value={DECISIONS_MODEL} readOnly />
      </div>
      <div className="space-y-1">
        <label htmlFor="decisions-api-key" className="text-sm font-medium">API Key</label>
        <div className="flex min-w-0 gap-2">
          <Input id="decisions-api-key" type="password" placeholder="OpenAI API key"
            value={key} onChange={event => setKey(event.target.value)} className="min-w-0 flex-1" />
          <Button size="icon" variant="outline" disabled={!key} title="Remove Decisions API key"
            aria-label="Remove Decisions API key" onClick={() => setKey("")}>
            <TrashIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error ? <p role="status" className="text-xs text-muted-foreground">{error}</p> : null}
    </section>
  );
}
