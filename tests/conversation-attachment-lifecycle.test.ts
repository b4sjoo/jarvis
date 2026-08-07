import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_ATTACHMENT_LIFECYCLE,
  selectAcceptedTransientImageFiles,
  selectTransientImagePayloads,
} from "../src/lib/conversation-attachment-lifecycle.js";

test("conversation attachments remain request-only image evidence", () => {
  assert.deepEqual(CONVERSATION_ATTACHMENT_LIFECYCLE, {
    maxFiles: 6,
    acceptedMimePrefix: "image/",
    requestPayload: "base64-images",
    persistence: "request-only",
    durableEvidence: false,
  });
});

test("request payload preserves image order and ignores non-image files", () => {
  const payloads = selectTransientImagePayloads([
    attachment("first", "image/png"),
    attachment("ignored", "application/pdf"),
    attachment("second", "image/jpeg"),
  ]);

  assert.deepEqual(payloads, ["first", "second"]);
});

test("multi-file selection cannot exceed the remaining attachment slots", () => {
  const files = [
    { name: "one.png", type: "image/png" },
    { name: "notes.txt", type: "text/plain" },
    { name: "two.jpg", type: "image/jpeg" },
    { name: "three.webp", type: "image/webp" },
  ];

  assert.deepEqual(
    selectAcceptedTransientImageFiles(files, 4).map((file) => file.name),
    ["one.png", "two.jpg"]
  );
  assert.deepEqual(selectAcceptedTransientImageFiles(files, 6), []);
});

test("request payload is capped even if invalid legacy state contains extras", () => {
  const attachments = Array.from({ length: 8 }, (_, index) =>
    attachment(String(index), "image/png")
  );

  assert.deepEqual(selectTransientImagePayloads(attachments), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
});

function attachment(base64: string, type: string) {
  return {
    id: base64,
    name: `${base64}.file`,
    type,
    base64,
    size: base64.length,
  };
}
