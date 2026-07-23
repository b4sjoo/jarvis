export type AnswerSufficiencySemanticClass =
  | "context-insufficient"
  | "not-context-insufficient";

export interface AnswerSufficiencySemanticPrototype {
  id: string;
  semanticClass: AnswerSufficiencySemanticClass;
  text: string;
  language: "en" | "zh" | "mixed";
  scenarioTags: string[];
}

export const ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPE_VERSION =
  "answer-sufficiency-semantic-prototypes-v1";

export const ANSWER_SUFFICIENCY_SEMANTIC_PROTOTYPES: AnswerSufficiencySemanticPrototype[] =
  [
    insufficient(
      "missing-original-task",
      "Question: Can you implement that now?\nAnswer: I cannot provide a concrete implementation because the original task, inputs, and expected output are missing."
    ),
    insufficient(
      "missing-antecedent",
      "Question: Would the same approach work here?\nAnswer: There is not enough preceding context to know what approach or system this refers to."
    ),
    insufficient(
      "artifact-placeholder",
      "Question: Please write the code.\nAnswer: I need the actual problem statement and constraints before I can produce the requested code."
    ),
    insufficient(
      "generic-meta-fallback",
      "Question: How should we change it?\nAnswer: More information about the current design is required before suggesting a meaningful change."
    ),
    insufficient(
      "fragmented-question",
      "Question: And if we need all of them instead?\nAnswer: The preceding operation is unavailable, so the requested variant cannot be answered concretely."
    ),
    insufficient(
      "missing-context-zh",
      "Question: 那这个应该怎么实现？\nAnswer: 当前缺少前面完整的题目、输入输出和约束，无法给出具体实现。",
      "zh"
    ),
    insufficient(
      "missing-context-mixed",
      "Question: Can you update the previous solution?\nAnswer: 我没有 previous solution 的上下文，需要原题和已有代码才能修改。",
      "mixed"
    ),

    sufficient(
      "legitimate-wait",
      "Question: Let's move to system design.\nAnswer: Ready for the system-design question; no solution should be generated until the actual requirements arrive."
    ),
    sufficient(
      "material-clarification",
      "Question: Design a ticket-selling system.\nAnswer: Before choosing the architecture, what peak QPS, consistency requirement, and ticket-hold duration should we assume?"
    ),
    sufficient(
      "fact-anchor-missing",
      "Question: What exact revenue did your project generate?\nAnswer: I do not have a verified revenue figure and should not invent one; I can describe the measured technical impact instead."
    ),
    sufficient(
      "provider-failure",
      "Question: Explain the design.\nAnswer: The model request timed out before an answer was produced."
    ),
    sufficient(
      "concrete-answer",
      "Question: How does a load balancer help this service?\nAnswer: It distributes requests across healthy instances, removes failed targets, and enables horizontal scaling while keeping the service endpoint stable."
    ),
    sufficient(
      "short-correct-answer",
      "Question: What is the time complexity of binary search?\nAnswer: O(log n)."
    ),
    sufficient(
      "artifact-present",
      "Question: Implement a queue using two stacks.\nAnswer: Use one stack for incoming values and transfer to the output stack only when needed. A complete code artifact is included."
    ),
    sufficient(
      "clarification-zh",
      "Question: 设计一个高并发抢票系统。\nAnswer: 在确定架构前，需要先确认峰值 QPS、超卖一致性要求以及订单保留时间。",
      "zh"
    ),
  ];

function insufficient(
  slug: string,
  text: string,
  language: AnswerSufficiencySemanticPrototype["language"] = "en"
): AnswerSufficiencySemanticPrototype {
  return prototype("context-insufficient", slug, text, language);
}

function sufficient(
  slug: string,
  text: string,
  language: AnswerSufficiencySemanticPrototype["language"] = "en"
): AnswerSufficiencySemanticPrototype {
  return prototype("not-context-insufficient", slug, text, language);
}

function prototype(
  semanticClass: AnswerSufficiencySemanticClass,
  slug: string,
  text: string,
  language: AnswerSufficiencySemanticPrototype["language"]
): AnswerSufficiencySemanticPrototype {
  return {
    id: `answer-sufficiency-${semanticClass}-${slug}`,
    semanticClass,
    text,
    language,
    scenarioTags: [slug],
  };
}
