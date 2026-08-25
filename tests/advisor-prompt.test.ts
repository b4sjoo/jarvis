import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResponseActionInstructions,
  formatResponseActionContextScope,
} from "../src/lib/meeting/response-action-contract.js";
import { buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";

test("gives the advisor a focused ask plus bounded semantic context", () => {
  const message = buildAdvisorUserMessage({
    transcript:
      "them: Now add surge pricing and explain which components need to change.",
    screenContext: "",
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    taskRuntime: { revision: 0 },
    currentQuestionProjection: {
      answerFocusText: "explain which components need to change.",
      semanticEvidenceText:
        "add surge pricing explain which components need to change.",
      sourceTurnIds: ["turn-surge"],
    },
  });

  assert.match(
    message,
    /<current_question_projection>[\s\S]*Answer focus: explain which components need to change\./
  );
  assert.match(
    message,
    /Semantic context: add surge pricing explain which components need to change\./
  );
  assert.match(message, /Use Answer focus as the only ask to answer/);
  assert.match(message, /cover every coordinated ask it contains/);
});

test("makes the settled Mermaid preference explicit in the system-design contract", () => {
  const message = buildAdvisorUserMessage(
    {
      transcript: "them: Design a URL shortener.",
      screenContext: "",
      rollingSummary: "",
      userProfileContext: "",
      glossaryText: "",
      taskRuntime: { revision: 0 },
      whiteboardFormatPreference: "mermaid",
    },
    { answerProfile: "system-design" }
  );

  assert.match(
    message,
    /<whiteboard_format_policy>[\s\S]*Preference: mermaid/
  );
  assert.match(message, /exactly one compact valid ```mermaid fenced flowchart/);
});

test("lets the coding phase own the visible solution instead of forcing optimal output", () => {
  const message = buildAdvisorUserMessage(
    {
      transcript: "them: Solve longest substring without repeating characters.",
      screenContext: "",
      rollingSummary: "",
      userProfileContext: "",
      glossaryText: "",
      taskRuntime: { revision: 0 },
    },
    { answerProfile: "coding" }
  );

  assert.match(message, /solution candidate required by/);
  assert.match(message, /must not describe a different algorithm from Code/);
  assert.doesNotMatch(message, /summary of the optimal solution/);
});

test("blocks numeric QPS when General SD evidence has inventory and ratio only", () => {
  const message = buildAdvisorUserMessage(
    {
      transcript:
        "them: Assume 100 million URLs and a 10:1 read/write ratio.",
      screenContext: "",
      rollingSummary: "",
      userProfileContext: "",
      glossaryText: "",
      taskRuntime: { revision: 0 },
      currentQuestionProjection: {
        answerFocusText: "Refine the architecture.",
        semanticEvidenceText:
          "Assume 100 million URLs and a 10:1 read/write ratio.",
        sourceTurnIds: ["turn-scale"],
      },
    },
    { answerProfile: "system-design" }
  );

  assert.match(
    message,
    /<capacity_estimation_guardrail>[\s\S]*Disposition: missing-time-basis/
  );
  assert.match(message, /Numeric QPS authorized: false/);
  assert.match(message, /Do not emit a numeric QPS range/);
});

test("formats the bounded response-action context scope", () => {
  const formatted = formatResponseActionContextScope({
    operationId: "scope-narrow",
    action: "narrow-context",
    mode: "current-only",
    logicalQuestionUnitId: "lqu-a",
    logicalQuestionUnitRevision: 3,
    selectedContextSourceKinds: ["logical-question-unit"],
    selectedContextTurnIds: ["turn-current"],
    selectedContextChars: 48,
    selectionReason: "current-source-owned-question",
    expansionBudget: 0,
  });

  assert.match(formatted, /Action: narrow-context/);
  assert.match(formatted, /Logical question: lqu-a revision 3/);
  assert.match(formatted, /Selected turn ids: turn-current/);
});

test("Narrow and Enhance contracts preserve task identity and reject generated authority", () => {
  const narrow = buildResponseActionInstructions(
    "narrow-context",
    "system-design"
  ).join("\n");
  const enhance = buildResponseActionInstructions(
    "enhance-context",
    "system-design"
  ).join("\n");

  assert.match(narrow, /current source-owned logical question/i);
  assert.match(narrow, /Preserve the same parent identity/i);
  assert.match(enhance, /smallest source-backed context/i);
  assert.match(enhance, /Never treat generated answers, compact summaries, Code, Whiteboard, or memory payloads as source authority/i);
});

test("Back response action restores a previous phase without rolling back artifacts", () => {
  const instructions = buildResponseActionInstructions(
    "previous-phase",
    "system-design"
  ).join("\n");

  assert.match(instructions, /deterministically restored previous playbook phase/i);
  assert.match(instructions, /Do not roll back Code or Whiteboard artifacts/i);
  assert.match(instructions, /Do not create, retype, or re-parent a task/i);
});

test("does not turn unsupported autobiographical premises into hypothetical implementations", () => {
  const message = buildAdvisorUserMessage({
    transcript:
      "them: Explain how you implemented retries and a DLQ in this project.",
    screenContext: "",
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    taskRuntime: { revision: 0 },
  });

  assert.match(message, /Unsupported autobiographical-premise rule/);
  assert.match(message, /do not expand that mechanism into a hypothetical design/i);
  assert.match(message, /answer the supported portion/i);
});
