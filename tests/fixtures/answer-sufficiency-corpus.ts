import type { CanonicalQuestionType } from "../../src/lib/meeting/task-taxonomy.js";
import type {
  AnswerRepairRecommendation,
  AnswerSufficiencyStatus,
} from "../../src/lib/meeting/answer-sufficiency.js";

export interface AnswerSufficiencyCorpusCase {
  id: string;
  question: string;
  questionType: CanonicalQuestionType;
  answer: string;
  expectedStatus: AnswerSufficiencyStatus;
  expectedRepair: AnswerRepairRecommendation;
  currentTurnAction?: "answer" | "append-context" | "buffer" | "ignore";
  factAnchorRequired?: boolean;
  factAnchorAvailable?: boolean;
  executionStatus?: "success" | "error" | "timeout" | "truncated";
}

export const ANSWER_SUFFICIENCY_CORPUS: AnswerSufficiencyCorpusCase[] = [
  {
    id: "missing-original-problem",
    question: "Are there other algorithms, and how does complexity differ?",
    questionType: "coding",
    answer:
      "Answer:\nI don't have the original problem, so I cannot compare the algorithms yet. Pending the original problem statement.",
    expectedStatus: "context-insufficient",
    expectedRepair: "enhance",
  },
  {
    id: "referential-script-request",
    question: "So, give me a script on that.",
    questionType: "coding",
    answer:
      "Answer:\nThe specific task and input/output are not clear yet.\n\nCode:\n-",
    expectedStatus: "context-insufficient",
    expectedRepair: "enhance",
  },
  {
    id: "chinese-missing-context",
    question: "那这个方案的时间复杂度是多少？",
    questionType: "coding",
    answer: "Answer:\n没有原题，我没有足够上下文确定复杂度。",
    expectedStatus: "context-insufficient",
    expectedRepair: "enhance",
  },
  {
    id: "legitimate-section-wait",
    question: "Now let's move to the system design section.",
    questionType: "unknown",
    answer:
      "Answer:\nThe specific system-design task is not defined yet. I will wait for the question.",
    expectedStatus: "legitimate-wait",
    expectedRepair: "wait",
  },
  {
    id: "buffered-incomplete-turn",
    question: "If we use a queue because",
    questionType: "general-system-design",
    answer: "Answer:\nI need the rest of the question.",
    currentTurnAction: "buffer",
    expectedStatus: "legitimate-wait",
    expectedRepair: "buffer",
  },
  {
    id: "valid-requirement-clarification",
    question: "Design a ticket selling system.",
    questionType: "general-system-design",
    answer:
      "Answer:\nI need one clarification before writing the design.\n\nClarifying question:\nWhat peak QPS and consistency guarantee should we design for?",
    expectedStatus: "clarification-needed",
    expectedRepair: "manual-clarification",
  },
  {
    id: "fact-anchor-missing",
    question: "Tell me about your impact on the project.",
    questionType: "project-deep-dive",
    answer:
      "Answer:\nI do not have a supported project fact for that claim.",
    factAnchorRequired: true,
    factAnchorAvailable: false,
    expectedStatus: "fact-anchor-missing",
    expectedRepair: "manual-clarification",
  },
  {
    id: "provider-timeout",
    question: "Implement sliding window maximum.",
    questionType: "coding",
    answer: "Answer:\nThe response timed out.",
    executionStatus: "timeout",
    expectedStatus: "execution-failure",
    expectedRepair: "none",
  },
  {
    id: "technical-need-language",
    question: "How would you design retries for this service?",
    questionType: "general-system-design",
    answer:
      "Answer:\nWe need idempotency keys, exponential backoff with jitter, bounded retries, and a dead-letter queue. This prevents retry storms while preserving failed work for inspection.",
    expectedStatus: "sufficient",
    expectedRepair: "none",
  },
  {
    id: "concrete-coding-answer",
    question: "Write a function that reverses a linked list.",
    questionType: "coding",
    answer:
      "Answer:\nUse three pointers and reverse each next link in one pass.\n\nCode:\n```python\ndef reverse(head):\n    prev = None\n    while head:\n        head.next, prev, head = prev, head, head.next\n    return prev\n```",
    expectedStatus: "sufficient",
    expectedRepair: "none",
  },
];
