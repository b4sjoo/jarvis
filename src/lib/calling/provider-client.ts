import type { ChatModelRouteConfig, SttRouteConfig } from "./model-routes.js";
import { fetch } from "@tauri-apps/plugin-http";
import { getChatProvider, getSttProvider } from "./provider-catalog.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildChatProviderRequest(input: {
  route: ChatModelRouteConfig;
  apiKey: string;
  messages: ChatMessage[];
}) {
  const provider = getChatProvider(input.route.provider);
  if (provider.protocol === "anthropic-messages") {
    const system = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    return {
      endpoint: provider.endpoint,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.route.model,
          system,
          messages: input.messages
            .filter((message) => message.role !== "system")
            .map((message) => ({
              role: message.role,
              content: message.content,
            })),
          max_tokens: input.route.maxOutputTokens,
          stream: false,
        }),
      } satisfies RequestInit,
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  return {
    endpoint: provider.endpoint,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.route.model,
        messages: input.messages,
        max_tokens: input.route.maxOutputTokens,
        stream: false,
      }),
    } satisfies RequestInit,
  };
}

export function parseChatProviderResponse(
  route: ChatModelRouteConfig,
  data: unknown
) {
  const provider = getChatProvider(route.provider);
  if (provider.protocol === "anthropic-messages") {
    const response = data as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = response.content
      ?.filter((part) => part.type === "text" && part.text)
      .map((part) => part.text?.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!content) throw new Error(`${provider.name} returned no text content.`);
    return content;
  }
  const response = data as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`${provider.name} returned no content.`);
  return content;
}

export async function requestChatCompletion(input: {
  route: ChatModelRouteConfig;
  apiKey: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}) {
  const request = buildChatProviderRequest(input);
  const response = await fetch(request.endpoint, {
    ...request.init,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
  }
  return parseChatProviderResponse(input.route, await response.json());
}

export function buildTranscriptionProviderRequest(input: {
  route: SttRouteConfig;
  apiKey: string;
  audio: Blob;
  prompt?: string;
}) {
  const provider = getSttProvider(input.route.provider);
  const form = new FormData();
  form.append("file", input.audio, "audio.wav");
  const headers: Record<string, string> = {};

  if (provider.protocol === "elevenlabs-transcription") {
    form.append("model_id", input.route.model);
    if (input.route.language.trim()) {
      form.append("language_code", input.route.language.trim());
    }
    headers["xi-api-key"] = input.apiKey;
  } else {
    form.append("model", input.route.model);
    if (input.route.language.trim()) {
      form.append("language", input.route.language.trim());
    }
    if (input.prompt?.trim()) form.append("prompt", input.prompt.trim());
    headers.Authorization = `Bearer ${input.apiKey}`;
  }

  return {
    endpoint: provider.endpoint,
    init: {
      method: "POST",
      headers,
      body: form,
    } satisfies RequestInit,
  };
}

export async function requestTranscription(input: {
  route: SttRouteConfig;
  apiKey: string;
  audio: Blob;
  prompt?: string;
  signal?: AbortSignal;
}) {
  const request = buildTranscriptionProviderRequest(input);
  const response = await fetch(request.endpoint, {
    ...request.init,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Transcription failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { text?: string };
  const text = data.text?.trim();
  if (!text) {
    throw new Error(
      `${getSttProvider(input.route.provider).name} returned no transcript.`
    );
  }
  return text;
}
