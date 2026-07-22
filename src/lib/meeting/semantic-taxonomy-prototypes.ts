import type { CanonicalQuestionType } from "./task-taxonomy.js";

export type ConcreteSemanticQuestionType = Exclude<
  CanonicalQuestionType,
  "unknown"
>;

export interface TaxonomySemanticPrototype {
  id: string;
  questionType: ConcreteSemanticQuestionType;
  polarity: "positive" | "hard-negative";
  text: string;
  language: "en" | "zh" | "mixed";
  scenarioTags: string[];
  source: "generic-curated" | "sanitized-regression";
}

export const SEMANTIC_TAXONOMY_PROTOTYPE_VERSION = "taxonomy-prototypes-v1";

export const SEMANTIC_TAXONOMY_PROTOTYPES: TaxonomySemanticPrototype[] = [
  positive("behavioral", "story-conflict", "Describe a specific past situation where you resolved a disagreement."),
  positive("behavioral", "story-failure", "Share a concrete example of a failure, missed commitment, or mistake and what you learned."),
  positive("behavioral", "story-leadership", "Tell a first-person story that demonstrates leadership, ownership, or influence."),
  positive("behavioral", "story-persuasion", "How did you convince or influence people who disagreed with you?"),
  positive("behavioral", "story-zh", "讲一个你过去遇到冲突、失败或需要影响他人的具体经历。", "zh"),
  hardNegative("behavioral", "hypothetical-design", "How would you design a new distributed service?"),
  hardNegative("behavioral", "project-mechanism", "Explain the architecture and implementation of the feature on your resume."),
  hardNegative("behavioral", "context-only", "I once worked through a difficult deadline with my team."),

  positive("coding", "implementation", "Write working code that implements the requested algorithm or data structure."),
  positive("coding", "algorithm", "Develop an efficient algorithm and analyze its time and space complexity."),
  positive("coding", "function", "Complete the function so that it returns the required output for every input."),
  positive("coding", "variant", "Modify the existing solution to handle this new input constraint or return all matches."),
  positive("coding", "implementation-mixed", "请写出可以运行的 Python implementation，并说明 complexity。", "mixed"),
  hardNegative("coding", "project-implementation", "How did you implement that production feature in your previous project?"),
  hardNegative("coding", "system-implementation", "How would you implement the backend architecture at scale?"),
  hardNegative("coding", "language-context", "Our backend was implemented in Java and Python."),

  positive("general-system-design", "service-design", "Architect a new large-scale online service from requirements through storage and APIs."),
  positive("general-system-design", "distributed-design", "Design a reliable distributed platform for high traffic, consistency, and availability."),
  positive("general-system-design", "capacity-design", "Estimate traffic and storage, then choose components for a scalable backend."),
  positive("general-system-design", "domain-system", "Build an end-to-end system for marketplace, delivery, booking, feed, or messaging workflows."),
  positive("general-system-design", "system-zh", "设计一个高并发的分布式后端系统，包括容量估算、数据模型和核心服务。", "zh"),
  hardNegative("general-system-design", "aiml-design", "Design the retrieval, model, training, evaluation, and serving pipeline for an AI product."),
  hardNegative("general-system-design", "project-architecture", "Walk through the production architecture that you personally built."),
  hardNegative("general-system-design", "context-only", "The service already has multi-region storage and a load balancer."),

  positive("ai-ml-system-design", "rag-design", "Design an end-to-end RAG product including retrieval, grounding, evaluation, and serving."),
  positive("ai-ml-system-design", "recommender-design", "Architect a recommendation system with data, features, models, feedback, and online inference."),
  positive("ai-ml-system-design", "model-platform", "Build a machine-learning platform for training, model versioning, rollout, monitoring, and GPU serving."),
  positive("ai-ml-system-design", "agent-design", "Design an intelligent agent that learns from feedback and uses tools or memory safely."),
  positive("ai-ml-system-design", "aiml-mixed", "设计一个 LLM 应用的 retrieval、model serving、evaluation 和 feedback pipeline。", "mixed"),
  hardNegative("ai-ml-system-design", "general-design", "Design a conventional ride-sharing backend with APIs, databases, and location updates."),
  hardNegative("ai-ml-system-design", "field-concept", "Explain how transformer attention or dense retrieval works conceptually."),
  hardNegative("ai-ml-system-design", "context-only", "The product already uses RAG, embeddings, and a vector store."),

  positive("project-deep-dive", "personal-contribution", "Explain your personal contribution, ownership, and impact in a project you actually built."),
  positive("project-deep-dive", "past-architecture", "Walk through the architecture and design choices of the production system on your resume."),
  positive("project-deep-dive", "past-tradeoff", "What difficult technical tradeoff did you make in that feature and why?"),
  positive("project-deep-dive", "past-validation", "How did you test, launch, monitor, or scale that project safely?"),
  positive("project-deep-dive", "project-mixed", "你简历上的这个 project 具体是怎么设计的，你个人负责什么？", "mixed"),
  hardNegative("project-deep-dive", "hypothetical-system", "How would you design a completely new service for this hypothetical requirement?"),
  hardNegative("project-deep-dive", "coding-request", "Implement this algorithm as a working function."),
  hardNegative("project-deep-dive", "project-context", "This project used Java, Redis, and a vector database."),

  positive("field-knowledge", "concept", "Explain what this technical concept is and how it works."),
  positive("field-knowledge", "comparison", "Compare two technical approaches and explain their tradeoffs."),
  positive("field-knowledge", "mechanism", "Why does this algorithm, protocol, database, or machine-learning mechanism behave this way?"),
  positive("field-knowledge", "component", "Where does this component fit and what role does it play in the architecture?"),
  positive("field-knowledge", "concept-zh", "解释这个技术概念的原理、适用场景以及主要 tradeoff。", "mixed"),
  hardNegative("field-knowledge", "full-design", "Design the complete production system and select all major components."),
  hardNegative("field-knowledge", "coding-request", "Write code that implements the algorithm."),
  hardNegative("field-knowledge", "context-only", "We use this database and caching approach in production."),
];

function positive(
  questionType: ConcreteSemanticQuestionType,
  slug: string,
  text: string,
  language: TaxonomySemanticPrototype["language"] = "en"
): TaxonomySemanticPrototype {
  return prototype(questionType, "positive", slug, text, language);
}

function hardNegative(
  questionType: ConcreteSemanticQuestionType,
  slug: string,
  text: string,
  language: TaxonomySemanticPrototype["language"] = "en"
): TaxonomySemanticPrototype {
  return prototype(questionType, "hard-negative", slug, text, language);
}

function prototype(
  questionType: ConcreteSemanticQuestionType,
  polarity: TaxonomySemanticPrototype["polarity"],
  slug: string,
  text: string,
  language: TaxonomySemanticPrototype["language"]
): TaxonomySemanticPrototype {
  return {
    id: `semantic-${questionType}-${polarity}-${slug}`,
    questionType,
    polarity,
    text,
    language,
    scenarioTags: [slug],
    source: "generic-curated",
  };
}
