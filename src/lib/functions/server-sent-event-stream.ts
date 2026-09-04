export type AIResponseStreamCompletionSignal =
  | "stream-eof"
  | "openai-done"
  | "anthropic-message-stop";

export type AIResponseStreamEvent =
  | { type: "data"; data: string }
  | { type: "complete"; signal: AIResponseStreamCompletionSignal };

export async function* decodeServerSentEventStream(input: {
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}): AsyncIterable<AIResponseStreamEvent> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (input.signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw new DOMException("AI response stream aborted", "AbortError");
    }

    const { done, value } = await reader.read();
    if (!done && input.signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw new DOMException("AI response stream aborted", "AbortError");
    }

    buffer += done
      ? decoder.decode()
      : decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop() || "";

    for (const line of lines) {
      const event = decodeServerSentEventLine(line);
      if (!event) continue;
      yield event;
      if (event.type === "complete") {
        void reader.cancel().catch(() => {});
        return;
      }
    }

    if (done) {
      yield { type: "complete", signal: "stream-eof" };
      return;
    }
  }
}

function decodeServerSentEventLine(
  line: string
): AIResponseStreamEvent | undefined {
  const normalized = line.trimStart();
  if (!normalized.startsWith("data:")) return undefined;

  const data = normalized.substring(5).trim();
  if (!data) return undefined;
  if (data === "[DONE]") {
    return { type: "complete", signal: "openai-done" };
  }

  try {
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.type === "message_stop"
    ) {
      return { type: "complete", signal: "anthropic-message-stop" };
    }
  } catch {
    // Provider data remains available to the content parser for its own handling.
  }
  return { type: "data", data };
}
