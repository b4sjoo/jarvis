import type { ChatModelRouteConfig, SttRouteConfig } from "./model-routes.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function requestChatCompletion(input: {
  route: ChatModelRouteConfig;
  apiKey: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}) {
  const response = await fetch(input.route.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.route.model,
      messages: input.messages,
      max_tokens: input.route.maxOutputTokens,
      stream: false,
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Model returned no content.");
  return content;
}

export async function requestTranscription(input: {
  route: SttRouteConfig;
  apiKey: string;
  audio: Blob;
  prompt?: string;
  signal?: AbortSignal;
}) {
  const form = new FormData();
  form.append("file", input.audio, "audio.wav");
  form.append("model", input.route.model);
  if (input.route.language.trim()) form.append("language", input.route.language.trim());
  if (input.prompt?.trim()) form.append("prompt", input.prompt.trim());
  const response = await fetch(input.route.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`Transcription failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { text?: string };
  const text = data.text?.trim();
  if (!text) throw new Error("Transcription returned no text.");
  return text;
}
