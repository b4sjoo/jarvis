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

export async function requestMultimodalCompletion(input: {
  route: ChatModelRouteConfig;
  apiKey: string;
  prompt: string;
  mediaType: string;
  base64Data: string;
  fileName: string;
  signal?: AbortSignal;
}) {
  const provider = getChatProvider(input.route.provider);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown>;
  if (provider.protocol === "anthropic-messages") {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const media = input.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: input.mediaType, data: input.base64Data } }
      : { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.base64Data } };
    body = {
      model: input.route.model,
      max_tokens: input.route.maxOutputTokens,
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }, media] }],
    };
  } else {
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    const media = input.mediaType === "application/pdf"
      ? { type: "file", file: { filename: input.fileName, file_data: `data:${input.mediaType};base64,${input.base64Data}` } }
      : { type: "image_url", image_url: { url: `data:${input.mediaType};base64,${input.base64Data}`, detail: "high" } };
    body = {
      model: input.route.model,
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }, media] }],
      max_tokens: input.route.maxOutputTokens,
    };
  }
  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Multimodal recovery failed (${response.status}): ${await response.text()}`);
  }
  return parseChatProviderResponse(input.route, await response.json());
}

export async function requestChatCompletionStream(input: {
  route: ChatModelRouteConfig;
  apiKey: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onText: (completeText: string) => void;
}) {
  const provider = getChatProvider(input.route.provider);
  const request = buildChatProviderRequest(input);
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  body.stream = true;
  const response = await fetch(request.endpoint, {
    ...request.init,
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error(`${provider.name} returned no response stream.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          delta?: { type?: string; text?: string };
        };
        const text = provider.protocol === "anthropic-messages"
          ? payload.delta?.text
          : payload.choices?.[0]?.delta?.content;
        if (text) {
          complete += text;
          input.onText(complete);
        }
      } catch {
        // Ignore provider keepalive and non-text events.
      }
    }
  }
  complete = complete.trim();
  if (!complete) throw new Error(`${provider.name} returned no streamed text content.`);
  return complete;
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
