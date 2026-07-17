import assert from "node:assert/strict";
import test from "node:test";
import {
  areCompatibleQuestionTypes,
  canQuestionTypeDecisionOverrideParent,
  fromHumanEvalQuestionType,
  fromInterviewBriefType,
  fromMemoryQuestionType,
  fromScreenTaskKind,
  inferCanonicalQuestionTypeFromText,
  inferQuestionTypeDecisionFromText,
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

test("uses action, object, and frame together for implement and stack questions", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "How did you implement this feature in production?"
    ),
    "project-deep-dive"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "Implement a scalable ticketing service"
    ),
    "general-system-design"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Implement a stack using two queues"),
    "coding"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText("Explain the stack data structure"),
    "field-knowledge"
  );
  assert.equal(inferCanonicalQuestionTypeFromText("implement"), undefined);
  assert.equal(
    inferCanonicalQuestionTypeFromText("What is your tech stack?"),
    "project-deep-dive"
  );
});

test("keeps the recorded recruiter project sequence out of coding", () => {
  const projectQuestions = [
    "Have you shipped a production backend API for an AI product?",
    "What was your specific personal contribution to the stack?",
    "What backend systems, key-value stores, vector databases, or caches did you use?",
    "How did you test it before production?",
    "Who were your primary partners and stakeholders?",
  ];

  for (const question of projectQuestions) {
    assert.equal(
      inferCanonicalQuestionTypeFromText(question),
      "project-deep-dive",
      question
    );
  }
});

test("returns evidence and confidence without promoting ambiguous vocabulary", () => {
  const projectDecision = inferQuestionTypeDecisionFromText(
    "What was your specific personal contribution to the stack?"
  );
  assert.equal(projectDecision.type, "project-deep-dive");
  assert.ok(projectDecision.confidence >= 0.8);
  assert.ok(projectDecision.margin >= 0.25);
  assert.ok(projectDecision.evidence.includes("past-project-intent"));
  assert.ok(projectDecision.ambiguousTerms.includes("stack"));
  assert.equal(canQuestionTypeDecisionOverrideParent(projectDecision), true);

  const ambiguousDecision = inferQuestionTypeDecisionFromText(
    "We used Java and a graph in the backend stack"
  );
  assert.notEqual(ambiguousDecision.type, "coding");
  assert.ok(ambiguousDecision.ambiguousTerms.includes("java"));
  assert.ok(ambiguousDecision.ambiguousTerms.includes("graph"));
  assert.equal(canQuestionTypeDecisionOverrideParent(ambiguousDecision), false);
});

test("preserves explicit coding signals despite project vocabulary", () => {
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "Implement a stack using two queues and explain the time complexity"
    ),
    "coding"
  );
  assert.equal(
    inferCanonicalQuestionTypeFromText(
      "What is the time complexity of this monotonic stack solution?"
    ),
    "coding"
  );
});
