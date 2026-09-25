import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const QUESTIONS = [
  "What does LRU stand for and how does an LRU cache work?",
  "What happens when an LRU cache reaches capacity?",
];
const ME_TRANSCRIPT = "I would clarify the cache capacity before I implement it.";

function wavSampleRate(audio) {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF"
    || audio.toString("ascii", 8, 12) !== "WAVE"
    || audio.readUInt32LE(4) + 8 !== audio.length) return null;
  let offset = 12;
  let sampleRate = null;
  let hasData = false;
  while (offset + 8 <= audio.length) {
    const size = audio.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > audio.length) return null;
    const name = audio.toString("ascii", offset, offset + 4);
    if (name === "fmt ") {
      if (sampleRate !== null || size < 16) return null;
      const format = audio.readUInt16LE(offset + 8);
      const channels = audio.readUInt16LE(offset + 10);
      const rate = audio.readUInt32LE(offset + 12);
      const byteRate = audio.readUInt32LE(offset + 16);
      const blockAlign = audio.readUInt16LE(offset + 20);
      const bits = audio.readUInt16LE(offset + 22);
      if (format !== 1 || channels !== 1 || bits !== 16
        || blockAlign !== 2 || byteRate !== rate * 2) return null;
      sampleRate = rate;
    } else if (name === "data") {
      if (hasData || size === 0 || size % 2 !== 0) return null;
      hasData = true;
    }
    offset = end + (size % 2);
  }
  return offset === audio.length && hasData ? sampleRate : null;
}

function currentQuestion(body) {
  const text = JSON.stringify(body);
  const current = text.split("<current_question>")[1]?.split("</current_question>")[0];
  return QUESTIONS.find((question) => current?.includes(question))
    ?? [...QUESTIONS].reverse().find((question) => text.includes(question));
}

function operationFor(body) {
  const system = body?.messages?.find((message) => message.role === "system")?.content;
  if (typeof system !== "string") return null;
  if (system.startsWith("Classify only the question type")) return "type";
  if (system.startsWith("Decide one thing only: whether the interviewer-owned source evidence")) return "opportunity";
  if (system.startsWith("Infer one meeting metadata field")) return "metadata";
  if (system.startsWith("Decide one thing only: whether the current interviewer question depends on and continues the supplied active parent")) return "parent-affinity";
  if (system.startsWith("Classify one canonical relationship")) return "canonical";
  if (system.includes("active child") && system.includes("Affinity")) return "child-affinity";
  if (system.startsWith("Decide one thing only: whether questionText explicitly depends")) return "visual";
  if (system.startsWith("Judge whether answerText resolves")) return "resolution";
  if (system.startsWith("Decide whether the current question requires")) return "evidence";
  if (system.startsWith("You are a live meeting co-pilot")) return "advisor";
  return null;
}

function fixedContent(operation, question) {
  const first = question === QUESTIONS[0];
  const answer = first
    ? "LRU stands for Least Recently Used. An LRU cache evicts the least recently accessed entry when full."
    : "When an LRU cache reaches capacity, it removes the least recently used entry before inserting a new one.";
  switch (operation) {
    case "opportunity":
      return JSON.stringify({ v: 4, d: "o", c: 0.9, t: [0], r: "ask" });
    case "type":
      return JSON.stringify({ v: 1, t: "field-knowledge", c: 0.99, e: question });
    case "metadata":
      return JSON.stringify({ schemaVersion: 1, company: null, confidence: 0, evidenceSpans: [], abstainReason: "No company is named in the question." });
    case "parent-affinity":
    case "child-affinity":
      return JSON.stringify(first
        ? { v: 1, d: "i", c: 0.95, q: question, b: null }
        : { v: 1, d: "r", c: 0.95, q: question, b: "how does an LRU cache work?" });
    case "canonical":
      return JSON.stringify({
        schemaVersion: 3,
        relation: first ? "new-parent" : "followup-parent",
        confidence: 0.95,
        currentQuestionEvidenceSpans: [question],
        parentEvidenceSpans: first ? [] : ["how does an LRU cache work?"],
      });
    case "visual":
      return JSON.stringify({ schemaVersion: 2, decision: "not-visual", questionEvidenceSpans: [question], visualEvidenceSpans: [] });
    case "resolution":
      return JSON.stringify({ schemaVersion: 2, decision: "resolved", questionEvidenceSpans: [question], answerEvidenceSpans: [answer] });
    case "evidence":
      return JSON.stringify({ schemaVersion: 2, decision: "not-required", questionEvidenceSpans: [question], visualEvidenceSpans: [] });
    case "advisor":
      return `中文思路: 说明LRU的行为。\n\nQuestion: ${question}\n\nAnswer: ${answer}\n\nApproach: Hash map and doubly linked list.\n\nClarifying question: -\nClarifying options: -\nAnswer disposition: not-fact-dependent\nSupporting anchor IDs: -`;
    default:
      throw new Error("Unexpected fixed Provider operation");
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(value));
}

export function createFixedProviderServer() {
  let sttSequence = 0;
  const handle = async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method-not-allowed" });
      return;
    }
    if (request.url === "/reset") {
      sttSequence = 0;
      sendJson(response, 200, { reset: true });
      return;
    }
    if (request.url === "/stt") {
      let audioBytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        audioBytes += chunk.length;
        if (audioBytes > 16_000_000) {
          sendJson(response, 413, { error: "audio-too-large" });
          return;
        }
        chunks.push(chunk);
      }
      let form;
      try {
        form = await new Request("http://127.0.0.1/stt", {
          method: "POST",
          headers: request.headers,
          body: Buffer.concat(chunks),
        }).formData();
      } catch {
        sendJson(response, 400, { error: "invalid-audio-form" });
        return;
      }
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        sendJson(response, 400, { error: "audio-file-required" });
        return;
      }
      const rate = wavSampleRate(Buffer.from(await file.arrayBuffer()));
      if (rate !== 16_000 && rate !== 48_000) {
        sendJson(response, 422, { error: "unexpected-wav-format" });
        return;
      }
      sendJson(response, 200, {
        text: rate === 16_000 ? ME_TRANSCRIPT : QUESTIONS[sttSequence++ % QUESTIONS.length],
      });
      return;
    }
    if (request.url !== "/ai") {
      sendJson(response, 404, { error: "unknown-path" });
      return;
    }
    let input = "";
    for await (const chunk of request) {
      input += chunk;
      if (input.length > 2_000_000) {
        sendJson(response, 413, { error: "input-too-large" });
        return;
      }
    }
    let body;
    try {
      body = JSON.parse(input);
    } catch {
      sendJson(response, 400, { error: "invalid-json" });
      return;
    }
    const operation = operationFor(body);
    const question = currentQuestion(body);
    if (!operation || !question) {
      sendJson(response, 422, { error: "unlisted-fixed-input" });
      return;
    }
    const content = fixedContent(operation, question);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    const midpoint = Math.ceil(content.length / 2);
    for (const part of [content.slice(0, midpoint), content.slice(midpoint)]) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (response.destroyed) return;
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  };
  return createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (request.aborted || response.destroyed || error?.code === "ECONNRESET") return;
      process.stderr.write(`NSD fixture handler failed: ${String(error)}\n`);
      if (!response.headersSent) sendJson(response, 500, { error: "fixture-handler-failed" });
      else response.destroy();
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createFixedProviderServer();
  server.listen(19921, "127.0.0.1", () => {
    process.stdout.write("NSD fixed Provider listening on 127.0.0.1:19921\n");
  });
}
