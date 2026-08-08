import { Button, Header, Input, Selection, TextInput } from "@/components";
import { extractVariables } from "@/lib";
import { SelectedAiProviderConfig, TYPE_PROVIDER } from "@/types";
import curl2Json, { ResultJSON } from "@bany/curl-to-json";
import { TrashIcon } from "lucide-react";

interface ProvidersProps {
  allAiProviders: TYPE_PROVIDER[];
  selectedProvider: SelectedAiProviderConfig;
  onSetSelectedProvider: (selection: SelectedAiProviderConfig) => void;
  title: string;
  description: string;
  placeholder: string;
}

export const Providers = ({
  allAiProviders,
  selectedProvider,
  onSetSelectedProvider,
  title,
  description,
  placeholder,
}: ProvidersProps) => {
  const providerDefinition = allAiProviders.find(
    (provider) => provider.id === selectedProvider.provider
  );
  const parsedProvider = providerDefinition
    ? (curl2Json(providerDefinition.curl) as ResultJSON)
    : null;
  const variables = extractVariables(providerDefinition?.curl ?? "");
  const apiKeyVariable = variables.find(
    (variable) => variable.key === "api_key"
  );
  const providerLabel = providerDefinition?.isCustom
    ? "Custom Provider"
    : selectedProvider.provider;
  const apiKeyValue = apiKeyVariable
    ? selectedProvider.variables[apiKeyVariable.key] ?? ""
    : "";

  const updateVariable = (key: string, value: string) => {
    onSetSelectedProvider({
      ...selectedProvider,
      variables: {
        ...selectedProvider.variables,
        [key]: value,
      },
    });
  };

  return (
    <section className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="space-y-2">
        <Header title={title} description={description} />
        <Selection
          selected={selectedProvider.provider}
          options={allAiProviders.map((provider) => {
            const parsed = curl2Json(provider.curl);
            return {
              label: provider.isCustom
                ? parsed.url || "Custom Provider"
                : provider.id || "Custom Provider",
              value: provider.id || "Custom Provider",
              isCustom: provider.isCustom,
            };
          })}
          placeholder={placeholder}
          onChange={(provider) => {
            onSetSelectedProvider({ provider, variables: {} });
          }}
        />
      </div>

      {parsedProvider ? (
        <Header
          title={`Method: ${parsedProvider.method || "Invalid"}, Endpoint: ${
            parsedProvider.url || "Invalid"
          }`}
          description="Create a custom provider to use a different endpoint or method."
        />
      ) : null}

      {apiKeyVariable ? (
        <div className="space-y-2">
          <Header
            title="API Key"
            description={`Enter the ${providerLabel || "provider"} API key. This role stores its own local credential values.`}
          />
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="**********"
              value={apiKeyValue}
              onChange={(value) => {
                updateVariable(
                  apiKeyVariable.key,
                  typeof value === "string" ? value : value.target.value
                );
              }}
              className="h-11 flex-1 border-1 border-input/50 transition-colors focus:border-primary/50"
            />
            {apiKeyValue.trim() ? (
              <Button
                onClick={() => updateVariable(apiKeyVariable.key, "")}
                size="icon"
                variant="destructive"
                className="h-11 w-11 shrink-0"
                title="Remove API Key"
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-2 space-y-4">
        {variables
          .filter((variable) => variable.key !== apiKeyVariable?.key)
          .map((variable) => (
            <div className="space-y-1" key={variable.key}>
              <Header
                title={variable.value}
                description={`Set the ${variable.key.replace(
                  /_/g,
                  " "
                )} used by ${providerLabel || "this provider"}.`}
              />
              <TextInput
                placeholder={`Enter ${providerLabel || "provider"} ${
                  variable.key.replace(/_/g, " ") || "value"
                }`}
                value={selectedProvider.variables[variable.key] || ""}
                onChange={(value) => updateVariable(variable.key, value)}
              />
            </div>
          ))}
      </div>
    </section>
  );
};
