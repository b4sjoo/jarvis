import { Header } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { CustomProviders } from "./CustomProvider";

export const AIProviders = (settings: UseSettingsReturn) => {
  return (
    <div id="ai-providers" className="space-y-3">
      <Header
        title="AI Providers"
        description="Select your preferred AI service provider to get started."
        isMainTitle
      />

      {/* Custom Provider */}
      <CustomProviders {...settings} />
      <Providers
        allAiProviders={settings.allAiProviders}
        selectedProvider={settings.selectedAIProvider}
        onSetSelectedProvider={settings.onSetSelectedAIProvider}
        title="Direct Conversation Model"
        description="Used by the main Jarvis conversation experience. This selection is independent from interview preparation."
        placeholder="Choose a conversation model"
      />
      <Providers
        allAiProviders={settings.allAiProviders}
        selectedProvider={settings.selectedPreparationAIProvider}
        onSetSelectedProvider={settings.onSetSelectedPreparationAIProvider}
        title="Preparation Model"
        description="Used for interview preparation conversations, material synthesis, and multimodal analysis. Configure a capable long-context model independently."
        placeholder="Choose a preparation model"
      />
    </div>
  );
};
