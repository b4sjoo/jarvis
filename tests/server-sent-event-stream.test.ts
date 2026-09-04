import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeServerSentEventStream,
  type AIResponseStreamEvent,
} from "../src/lib/functions/server-sent-event-stream.js";

async function collect(input: {
  chunks: string[];
  close?: boolean;
  onCancel?: () => void;
}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of input.chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (input.close !== false) controller.close();
    },
    cancel() {
      input.onCancel?.();
    },
  });
  const events: AIResponseStreamEvent[] = [];
  for await (const event of decodeServerSentEventStream({ body })) {
    events.push(event);
  }
  return events;
}

test("completes an OpenAI stream at DONE without waiting for EOF", async () => {
  let cancelled = false;
  const events = await collect({
    chunks: [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
        "data: [DONE]\n\n",
    ],
    close: false,
    onCancel: () => {
      cancelled = true;
    },
  });

  assert.deepEqual(events, [
    {
      type: "data",
      data: '{"choices":[{"delta":{"content":"hello"}}]}',
    },
    { type: "complete", signal: "openai-done" },
  ]);
  assert.equal(cancelled, true);
});

test("completes an Anthropic stream at message_stop without waiting for EOF", async () => {
  let cancelled = false;
  const events = await collect({
    chunks: [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
    close: false,
    onCancel: () => {
      cancelled = true;
    },
  });

  assert.deepEqual(events, [
    {
      type: "data",
      data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
    },
    { type: "complete", signal: "anthropic-message-stop" },
  ]);
  assert.equal(cancelled, true);
});

test("processes a final unterminated data line before EOF", async () => {
  const events = await collect({
    chunks: ['data: {"choices":[{"delta":{"content":"tail"}}]}'],
  });

  assert.deepEqual(events, [
    {
      type: "data",
      data: '{"choices":[{"delta":{"content":"tail"}}]}',
    },
    { type: "complete", signal: "stream-eof" },
  ]);
});
