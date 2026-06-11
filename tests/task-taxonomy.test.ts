import assert from "node:assert/strict";
import test from "node:test";
import {
  areCompatibleQuestionTypes,
  fromHumanEvalQuestionType,
  fromInterviewBriefType,
  fromMemoryQuestionType,
  fromScreenTaskKind,
  inferCanonicalQuestionTypeFromText,
  isParentCanonicalQuestionType,
  isQuestionTypeCompatibleWithMemoryFamily,
  memoryFamiliesForQuestionType,
  normalizeCanonicalQuestionType,
  normalizeInterviewBriefTypes,
  normalizeMemoryInterviewTypes,
  normalizeQuestionTypeAlias,
  readInterviewBriefType,
  readSingleConcreteInterviewTypeOverride,
  toHumanEvalQuestionType,
  toInterviewBriefType,
  toMemoryQuestionType,
  toMemoryUseCaseForQuestionType,
  toScreenTaskKind,
} from "../src/lib/meeting/task-taxonomy.js";

test("normalizes legacy system-design alias to the canonical general-system-design type", () => {
  assert.equal(
    normalizeCanonicalQuestionType("system-design"),
    "general-system-design"
  );
  assert.equal(
    normalizeQuestionTypeAlias("system-design"),
    "general-system-design"
  );
  assert.equal(
    fromScreenTaskKind("system-design"),
    "general-system-design"
  );
  assert.equal(
    fromMemoryQuestionType("system-design"),
    "general-system-design"
  );
  assert.equal(
    fromHumanEvalQuestionType("system-design"),
    "general-system-design"
  );
  assert.equal(
    areCompatibleQuestionTypes("system-design", "general-system-design"),
    true
  );
});

test("keeps transitional screen-only labels out of canonical question types", () => {
  assert.equal(normalizeCanonicalQuestionType("ambiguous"), undefined);
  assert.equal(normalizeCanonicalQuestionType("non-question"), undefined);
  assert.equal(normalizeQuestionTypeAlias("ambiguous"), "ambiguous");
  assert.equal(normalizeQuestionTypeAlias("non-question"), "non-question");
});

test("maps interview brief UI values through canonical runtime values", () => {
  assert.equal(
    readInterviewBriefType("general-system-design"),
    "system-design"
  );
  assert.equal(
    fromInterviewBriefType("system-design"),
    "general-system-design"
  );
  assert.equal(
    toInterviewBriefType("general-system-design"),
    "system-design"
  );
  assert.equal(toInterviewBriefType("field-knowledge"), undefined);
  assert.equal(
    readSingleConcreteInterviewTypeOverride({
      interviewTypes: ["system-design"],
    }),
    "general-system-design"
  );
  assert.equal(
    readSingleConcreteInterviewTypeOverride({
      interviewTypes: ["system-design", "mixed"],
    }),
    undefined
  );
});

test("normalizes mixed interview brief selections while preserving UI vocabulary", () => {
  assert.deepEqual(
    normalizeInterviewBriefTypes(["behavioral", "coding"]),
    ["behavioral", "coding"]
  );
  assert.deepEqual(
    normalizeInterviewBriefTypes(["mixed"]),
    [
      "behavioral",
      "coding",
      "system-design",
      "ai-ml-system-design",
      "project-deep-dive",
      "mixed",
    ]
  );
  assert.deepEqual(
    normalizeInterviewBriefTypes([
      "behavioral",
      "coding",
      "system-design",
      "ai-ml-system-design",
      "project-deep-dive",
    ]),
    [
      "behavioral",
      "coding",
      "system-design",
      "ai-ml-system-design",
      "project-deep-dive",
      "mixed",
    ]
  );
});

test("maps canonical question types to memory use cases and memory families", () => {
  assert.equal(
    toMemoryUseCaseForQuestionType("meeting_assistant", "behavioral"),
    "behavioral_interview"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType("meeting_assistant", "coding"),
    "coding_interview"
  );
  assert.equal(
    toMemoryUseCaseForQuestionType(
      "behavioral_interview",
      "ai-ml-system-design"
    ),
    "meeting_assistant"
  );
  assert.deepEqual(memoryFamiliesForQuestionType("behavioral"), [
    "behavioral",
  ]);
  assert.deepEqual(memoryFamiliesForQuestionType("general-system-design"), [
    "system-design",
  ]);
  assert.deepEqual(memoryFamiliesForQuestionType("field-knowledge"), [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.equal(
    isQuestionTypeCompatibleWithMemoryFamily("system-design", "system-design"),
    true
  );
  assert.equal(
    isQuestionTypeCompatibleWithMemoryFamily("behavioral", "system-design"),
    false
  );
  assert.equal(
    isQuestionTypeCompatibleWithMemoryFamily(
      "field-knowledge",
      "project-deep-dive"
    ),
    false
  );
});

test("normalizes memory interview family lists without treating family labels as canonical question types", () => {
  assert.deepEqual(
    normalizeMemoryInterviewTypes(["system-design", "mixed", "system-design"]),
    ["system-design", "mixed"]
  );
  assert.equal(normalizeMemoryInterviewTypes(undefined), undefined);
});

test("maps canonical values to boundary types", () => {
  assert.equal(toScreenTaskKind("field-knowledge"), "field-knowledge");
  assert.equal(toScreenTaskKind("non-question"), "non-question");
  assert.equal(toMemoryQuestionType("general-system-design"), "general-system-design");
  assert.equal(toHumanEvalQuestionType("general-system-design"), "general-system-design");
});

test("identifies parent-eligible canonical task types", () => {
  assert.equal(isParentCanonicalQuestionType("behavioral"), true);
  assert.equal(isParentCanonicalQuestionType("coding"), true);
  assert.equal(isParentCanonicalQuestionType("field-knowledge"), false);
  assert.equal(isParentCanonicalQuestionType("unknown"), false);
});

test("infers canonical question type from lightweight text signals", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText("Design a ticket selling system"),
    "general-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Design a RAG evaluation platform"),
    "ai-ml-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Tell me about a time you missed a commitment"),
    "behavioral"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Walk me through your project architecture"),
    "project-deep-dive"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Explain the tradeoff between BM25 and dense retrieval"),
    "field-knowledge"
  );
  assert.equal(inferCanonicalQuestionTypeFromText("hello"), undefined);
});
