export type SemanticInterviewerIntentHead =
  | "speech-act"
  | "relation"
  | "evidence-mode";

export type SemanticInterviewerIntentValue =
  | "question"
  | "directive"
  | "constraint"
  | "correction"
  | "acknowledgement"
  | "section-transition"
  | "logistics"
  | "informational"
  | "new-parent"
  | "followup-parent"
  | "child-probe"
  | "linked-parent-extension"
  | "none"
  | "personal-experience"
  | "hypothetical-design"
  | "factual-explanation"
  | "unknown";

export interface SemanticInterviewerIntentPrototype {
  id: string;
  head: SemanticInterviewerIntentHead;
  value: SemanticInterviewerIntentValue;
  polarity: "positive" | "hard-negative";
  text: string;
  language: "en" | "zh" | "mixed";
  scenarioTags: string[];
}

export const SEMANTIC_INTERVIEWER_INTENT_PROTOTYPE_VERSION =
  "semantic-interviewer-intent-prototypes-v1";

export const SEMANTIC_INTERVIEWER_INTENT_PROTOTYPES: SemanticInterviewerIntentPrototype[] =
  [
    positive("speech-act", "question", "question-wh", "What tradeoffs would you consider and why?"),
    positive("speech-act", "question", "question-yes-no", "Can this design handle a regional failure?"),
    hardNegative("speech-act", "question", "question-indirect", "We discussed where the data should live."),
    positive("speech-act", "directive", "directive-design", "Design a reliable ticket-selling service."),
    positive("speech-act", "directive", "directive-code", "Write the function and analyze its complexity."),
    hardNegative("speech-act", "directive", "directive-history", "You wrote the service in Java last year."),
    positive("speech-act", "constraint", "constraint-assume", "Assume traffic doubles and all writes require strong consistency."),
    positive("speech-act", "constraint", "constraint-language", "Use Java instead of Python for the implementation."),
    hardNegative("speech-act", "constraint", "constraint-background", "The existing service happens to use Java."),
    positive("speech-act", "correction", "correction-term", "I mean retrieval augmented generation, not a recommendation engine."),
    positive("speech-act", "correction", "correction-scope", "Actually, limit the design to the write path."),
    hardNegative("speech-act", "correction", "correction-negative-fact", "The service does not use a relational database."),
    positive("speech-act", "acknowledgement", "ack-good", "Looks good to me."),
    positive("speech-act", "acknowledgement", "ack-thanks", "Okay, great, thank you."),
    hardNegative("speech-act", "acknowledgement", "ack-plus-ask", "Looks good; now implement the queue."),
    positive("speech-act", "section-transition", "transition-coding", "Let's move on to the coding section."),
    positive("speech-act", "section-transition", "transition-design", "Next, we will look at a system-design problem."),
    hardNegative("speech-act", "section-transition", "transition-with-question", "Now design a ride-sharing service."),
    positive("speech-act", "logistics", "logistics-time", "We have about ten minutes left in the interview."),
    positive("speech-act", "logistics", "logistics-screen", "Can you see the shared screen clearly?"),
    hardNegative("speech-act", "logistics", "logistics-technical-time", "Estimate how long the cache entry should remain valid."),
    positive("speech-act", "informational", "informational-background", "Our current platform uses Kafka and PostgreSQL."),
    positive("speech-act", "informational", "informational-recruiter", "The next interview round has two technical sessions."),
    hardNegative("speech-act", "informational", "informational-ask", "Explain why the platform uses Kafka."),
    positive("speech-act", "question", "question-zh", "这个系统为什么需要向量数据库？", "zh"),
    positive("speech-act", "directive", "directive-zh", "请设计一个高并发的抢票系统。", "zh"),
    positive("speech-act", "constraint", "constraint-mixed", "Assume 峰值 QPS 是十万，并且不能超卖。", "mixed"),

    positive("relation", "new-parent", "new-parent-domain", "Current: Design a binary tree algorithm.\nParent: Explain your previous memory project. The current unit is an independent new interview problem."),
    positive("relation", "new-parent", "new-parent-switch", "Current: Now move to a new system-design question about ride sharing.\nParent: The previous task was behavioral. This explicitly opens a new parent."),
    hardNegative("relation", "new-parent", "new-parent-same-product", "Current: Add a recommendation model to this food-delivery system.\nParent: Design the food-delivery backend. The product scenario continues."),
    positive("relation", "followup-parent", "followup-referential", "Current: How would that change if traffic doubled?\nParent: Design the ticket-selling system. The current unit refers to and modifies the same task."),
    positive("relation", "followup-parent", "followup-variant", "Current: Return every matching file instead of only the first.\nParent: Write a file-search function. This is a variant of the active task."),
    hardNegative("relation", "followup-parent", "followup-new-domain", "Current: Tell me about a conflict you handled.\nParent: Design a distributed cache. These are separate parent tasks."),
    positive("relation", "child-probe", "child-concept", "Current: Briefly explain consistent hashing.\nParent: Design a distributed cache. This is a bounded technical concept probe inside the parent."),
    positive("relation", "child-probe", "child-code", "Current: Implement the loss function.\nParent: Design the training pipeline. This is a bounded leaf task before returning to the parent."),
    hardNegative("relation", "child-probe", "child-full-switch", "Current: Design an entire search platform.\nParent: Explain consistent hashing. The current request is not a short child probe."),
    positive("relation", "linked-parent-extension", "extension-ml", "Current: Add a self-evolving recommendation agent to the food-delivery product.\nParent: Design the food-delivery backend. This extends the same product into a distinct AI/ML parent."),
    positive("relation", "linked-parent-extension", "extension-general", "Current: Now design the serving platform around this ranking model.\nParent: Design the ranking model. The domain is shared but the parent track changes."),
    hardNegative("relation", "linked-parent-extension", "extension-unrelated", "Current: Implement merge sort.\nParent: Design a travel recommendation system. There is no shared scenario extension."),
    positive("relation", "none", "none-no-parent", "Current: We have five minutes left.\nParent: none. This is logistics and has no task relation."),
    positive("relation", "none", "none-filler", "Current: Looks good, thanks.\nParent: Design a queue. This acknowledgement does not alter task relation."),
    hardNegative("relation", "none", "none-referential", "Current: What about the database for that service?\nParent: Design a marketplace. This clearly relates to the parent."),

    positive("evidence-mode", "personal-experience", "personal-story", "Tell me about a time you disagreed with a teammate and what you personally did."),
    positive("evidence-mode", "personal-experience", "personal-project", "In the system on your resume, what did you own and implement?"),
    hardNegative("evidence-mode", "personal-experience", "personal-hypothetical", "How would you design a new service from scratch?"),
    positive("evidence-mode", "hypothetical-design", "hypothetical-system", "Design a scalable ride-sharing platform for a new product."),
    positive("evidence-mode", "hypothetical-design", "hypothetical-code", "Write an algorithm that returns the maximum window value."),
    hardNegative("evidence-mode", "hypothetical-design", "hypothetical-past", "What architecture did you build in your previous role?"),
    positive("evidence-mode", "factual-explanation", "factual-concept", "Explain how dense retrieval works and compare it with sparse retrieval."),
    positive("evidence-mode", "factual-explanation", "factual-component", "What does a load balancer do in this architecture?"),
    hardNegative("evidence-mode", "factual-explanation", "factual-full-design", "Design the complete retrieval and serving architecture."),
    positive("evidence-mode", "unknown", "unknown-logistics", "The interview will end in ten minutes."),
    positive("evidence-mode", "unknown", "unknown-transition", "Let's move to the next section."),
    hardNegative("evidence-mode", "unknown", "unknown-concrete", "Tell me about a failure in your last project."),
  ];

function positive(
  head: SemanticInterviewerIntentHead,
  value: SemanticInterviewerIntentValue,
  slug: string,
  text: string,
  language: SemanticInterviewerIntentPrototype["language"] = "en"
) {
  return prototype(head, value, "positive", slug, text, language);
}

function hardNegative(
  head: SemanticInterviewerIntentHead,
  value: SemanticInterviewerIntentValue,
  slug: string,
  text: string,
  language: SemanticInterviewerIntentPrototype["language"] = "en"
) {
  return prototype(head, value, "hard-negative", slug, text, language);
}

function prototype(
  head: SemanticInterviewerIntentHead,
  value: SemanticInterviewerIntentValue,
  polarity: SemanticInterviewerIntentPrototype["polarity"],
  slug: string,
  text: string,
  language: SemanticInterviewerIntentPrototype["language"]
): SemanticInterviewerIntentPrototype {
  return {
    id: `interviewer-intent-${head}-${value}-${polarity}-${slug}`,
    head,
    value,
    polarity,
    text,
    language,
    scenarioTags: [slug],
  };
}
