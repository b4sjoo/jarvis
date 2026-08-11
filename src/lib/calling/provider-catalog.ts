export const CHAT_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "groq",
  "mistral",
  "openrouter",
  "perplexity",
  "ollama",
] as const;

export type ChatProviderId = (typeof CHAT_PROVIDER_IDS)[number];
export type ChatProviderProtocol = "openai-chat" | "anthropic-messages";

export interface ChatProviderPreset {
  id: ChatProviderId;
  name: string;
  endpoint: string;
  protocol: ChatProviderProtocol;
  requiresApiKey: boolean;
}

export const CHAT_PROVIDERS: readonly ChatProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    protocol: "anthropic-messages",
    requiresApiKey: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "xai",
    name: "xAI",
    endpoint: "https://api.x.ai/v1/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "groq",
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    endpoint: "https://api.perplexity.ai/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: true,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    endpoint: "http://localhost:11434/v1/chat/completions",
    protocol: "openai-chat",
    requiresApiKey: false,
  },
];

export const STT_PROVIDER_IDS = [
  "openai-whisper",
  "groq-whisper",
  "elevenlabs",
] as const;

export type SttProviderId = (typeof STT_PROVIDER_IDS)[number];
export type SttProviderProtocol =
  | "openai-transcription"
  | "elevenlabs-transcription";

export interface SttProviderPreset {
  id: SttProviderId;
  name: string;
  endpoint: string;
  protocol: SttProviderProtocol;
  requiresApiKey: boolean;
}

export const STT_PROVIDERS: readonly SttProviderPreset[] = [
  {
    id: "openai-whisper",
    name: "OpenAI Speech-to-Text",
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    protocol: "openai-transcription",
    requiresApiKey: true,
  },
  {
    id: "groq-whisper",
    name: "Groq Speech-to-Text",
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    protocol: "openai-transcription",
    requiresApiKey: true,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs Speech-to-Text",
    endpoint: "https://api.elevenlabs.io/v1/speech-to-text",
    protocol: "elevenlabs-transcription",
    requiresApiKey: true,
  },
];

export interface SttLanguageOption {
  code: string;
  name: string;
  flag: string;
}

export const STT_LANGUAGES: readonly SttLanguageOption[] = [
  { code: "", name: "Auto detect", flag: "🌐" },
  { code: "en", name: "English", flag: "🇺🇸" },
  { code: "zh", name: "Chinese", flag: "🇨🇳" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹" },
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "ko", name: "Korean", flag: "🇰🇷" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "nl", name: "Dutch", flag: "🇳🇱" },
  { code: "tr", name: "Turkish", flag: "🇹🇷" },
  { code: "pl", name: "Polish", flag: "🇵🇱" },
  { code: "sv", name: "Swedish", flag: "🇸🇪" },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳" },
  { code: "th", name: "Thai", flag: "🇹🇭" },
  { code: "id", name: "Indonesian", flag: "🇮🇩" },
];

const chatById = new Map(CHAT_PROVIDERS.map((provider) => [provider.id, provider]));
const sttById = new Map(STT_PROVIDERS.map((provider) => [provider.id, provider]));

export function isChatProviderId(value: unknown): value is ChatProviderId {
  return typeof value === "string" && chatById.has(value as ChatProviderId);
}

export function isSttProviderId(value: unknown): value is SttProviderId {
  return typeof value === "string" && sttById.has(value as SttProviderId);
}

export function getChatProvider(id: ChatProviderId) {
  const provider = chatById.get(id);
  if (!provider) throw new Error(`Unsupported chat provider: ${id}`);
  return provider;
}

export function getSttProvider(id: SttProviderId) {
  const provider = sttById.get(id);
  if (!provider) throw new Error(`Unsupported STT provider: ${id}`);
  return provider;
}

export function inferChatProvider(endpoint: unknown) {
  if (typeof endpoint !== "string") return undefined;
  return CHAT_PROVIDERS.find((provider) => provider.endpoint === endpoint)?.id;
}

export function inferSttProvider(endpoint: unknown) {
  if (typeof endpoint !== "string") return undefined;
  return STT_PROVIDERS.find((provider) => provider.endpoint === endpoint)?.id;
}
