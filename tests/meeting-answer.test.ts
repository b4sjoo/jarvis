import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMeetingAnswerSummary,
  formatMeetingAnswerTraceMetadata,
  parseMeetingAnswer,
  readMeetingAnswerSection,
  resolveMeetingAnswerProfile,
} from "../src/lib/meeting/meeting-answer.js";
import { parseScreenTaskAnswer } from "../src/lib/meeting/screen-task-answer.js";

test("parses legacy live Reply without consuming Question", () => {
  const parsed = parseMeetingAnswer(`中文思路: 这是项目追问。
Reply: I owned the retrieval and mutation pipeline.
Question: Would you like the architecture or the rollout details?`);

  assert.equal(parsed.sections.answer, "I owned the retrieval and mutation pipeline.");
  assert.equal(
    parsed.sections.question,
    "Would you like the architecture or the rollout details?"
  );
  assert.equal(parsed.primaryAnswerSource, "reply-alias");
  assert.equal(parsed.contractVersion, "legacy-live-v1");
  assert.equal(parsed.parseStatus, "parsed");
});

test("prefers canonical Answer when Answer and Reply are both present", () => {
  const parsed = parseMeetingAnswer(`Answer: Canonical answer.
Reply: Legacy answer.`);

  assert.equal(parsed.sections.answer, "Canonical answer.");
  assert.equal(parsed.primaryAnswerSource, "answer");
  assert.equal(parsed.contractVersion, "meeting-answer-v2");
});

test("parses canonical coding answer and strips the outer code fence", () => {
  const parsed = parseMeetingAnswer(
    `中文思路: 使用单调队列。
Question: Return the sliding-window maximum.
Answer: Maintain decreasing candidate indices.
Approach: Pop smaller values before appending each index.
Code:
\`\`\`python
def max_sliding_window(nums, k):
    return []
\`\`\`
Complexity: O(n) time and O(k) space.
Clarifying question: -
Clarifying options: -`,
    { expectedProfile: "coding", now: 42 }
  );

  assert.equal(parsed.sections.code, "def max_sliding_window(nums, k):\n    return []");
  assert.equal(parsed.sections.complexity, "O(n) time and O(k) space.");
  assert.deepEqual(parsed.missingExpectedSections, []);
  assert.equal(parsed.parsedAt, 42);
});

test("recovers a fenced code block misplaced in Approach", () => {
  const parsed = parseMeetingAnswer(`Answer: Use a stack.
Approach: Explain the invariant.
\`\`\`typescript
function solve(): number { return 1; }
\`\`\`
Complexity: O(n).`);

  assert.equal(parsed.sections.approach, "Explain the invariant.");
  assert.equal(
    parsed.sections.code,
    "function solve(): number { return 1; }"
  );
});

test("supports Markdown labels and infrastructure diagram alias", () => {
  const parsed = parseMeetingAnswer(`## **中文思路:** 先明确写路径。
**Answer:** Separate the write and read paths.
### Infrastructure diagram
Client -> API -> Queue -> Worker
**Clarifying question:** Which consistency level matters?
**Clarifying options:** Strong | Eventual`);

  assert.equal(parsed.sections.answer, "Separate the write and read paths.");
  assert.equal(parsed.sections.whiteboard, "Client -> API -> Queue -> Worker");
  assert.equal(parsed.sections.clarifyingQuestion, "Which consistency level matters?");
  assert.deepEqual(
    parsed.sections.clarifyingOptions.map((option) => option.label),
    ["Strong", "Eventual"]
  );
});

test("marks an incomplete streamed section as partial without throwing", () => {
  const parsed = parseMeetingAnswer(`中文思路: 先澄清规模。
Answer:`);

  assert.equal(parsed.parseStatus, "partial");
  assert.equal(parsed.sections.chineseThinking, "先澄清规模。");
  assert.equal(parsed.sections.answer, undefined);
});

test("marks an unclosed code fence as partial", () => {
  const parsed = parseMeetingAnswer(`Answer: Use a queue.
Code:
\`\`\`python
def solve():`);

  assert.equal(parsed.parseStatus, "partial");
});

test("uses useful unlabeled content as a fallback answer", () => {
  const parsed = parseMeetingAnswer("Use a bounded queue and backpressure.");

  assert.equal(parsed.sections.answer, "Use a bounded queue and backpressure.");
  assert.equal(parsed.primaryAnswerSource, "fallback");
  assert.equal(parsed.parseStatus, "fallback");
  assert.equal(parsed.contractVersion, "unstructured");
});

test("treats dash-only output as empty", () => {
  const parsed = parseMeetingAnswer("-");

  assert.equal(parsed.parseStatus, "empty");
  assert.equal(parsed.primaryAnswerSource, "none");
  assert.equal(parsed.sections.answer, undefined);
});

test("compatibility screen parser delegates to canonical parser", () => {
  const parsed = parseScreenTaskAnswer(`中文思路: 保留兼容层。
Answer: Shared parser result.
Approach: One parser.`);

  assert.equal(parsed.answer, "Shared parser result.");
  assert.equal(parsed.approach, "One parser.");
});

test("clarifying question has an independent boundary", () => {
  const content = `Question: Design a ticket system.
Answer: Start with the inventory invariant.
Clarifying question: What is the peak QPS?
Clarifying options: 1k | 10k | 100k`;

  assert.equal(readMeetingAnswerSection(content, ["Question"]), "Design a ticket system.");
  assert.equal(
    readMeetingAnswerSection(content, ["Clarifying question"]),
    "What is the peak QPS?"
  );
});

test("builds a bounded continuity summary from a legacy live reply", () => {
  const parsed = parseMeetingAnswer(`中文思路: 不重复注入双语内容。
Reply: Explain the stable parent task first.
Question: Architecture or rollout?
Code:
\`\`\`typescript
const ignored = true;
\`\`\``);
  const summary = buildMeetingAnswerSummary(parsed);

  assert.equal(summary.text, "Answer: Explain the stable parent task first.");
  assert.equal(summary.source, "reply-alias");
  assert.deepEqual(summary.includedSections, ["Answer"]);
  assert.equal(summary.excludedCode, true);
});

test("does not produce continuity for partial output", () => {
  const parsed = parseMeetingAnswer("Answer:");
  const summary = buildMeetingAnswerSummary(parsed);

  assert.equal(summary.text, "");
  assert.equal(summary.chars, 0);
  assert.equal(summary.parseStatus, "partial");
});

test("does not overwrite continuity with a low-value acknowledgement", () => {
  const parsed = parseMeetingAnswer("Reply: Sure.");
  const summary = buildMeetingAnswerSummary(parsed);

  assert.equal(summary.text, "");
  assert.deepEqual(summary.includedSections, []);
});

test("records bounded answer-contract trace metadata", () => {
  const parsed = parseMeetingAnswer("Answer: Keep the trace compact.");
  const metadata = formatMeetingAnswerTraceMetadata(parsed);

  assert.equal(metadata.answerContractVersion, "meeting-answer-v2");
  assert.equal(metadata.answerParseStatus, "parsed");
  assert.equal(metadata.latestUsefulAnswerChars, 31);
  assert.deepEqual(metadata.continuitySummaryIncludedSections, ["Answer"]);
});

test("maps effective question types to stable answer profiles", () => {
  assert.equal(resolveMeetingAnswerProfile("behavioral"), "compact-spoken");
  assert.equal(resolveMeetingAnswerProfile("field-knowledge"), "technical");
  assert.equal(resolveMeetingAnswerProfile("coding"), "coding");
  assert.equal(
    resolveMeetingAnswerProfile("ai-ml-system-design"),
    "system-design"
  );
});
