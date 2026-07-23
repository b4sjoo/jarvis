import type {
  CanonicalQuestionType,
  TaxonomyInterviewBriefType,
} from "../../src/lib/meeting/task-taxonomy.js";
import type { TaxonomyAdjudicationRelation } from "../../src/lib/meeting/taxonomy-adjudication.js";

export interface TaxonomyAdjudicationCorpusCase {
  id: string;
  text: string;
  parentType?: CanonicalQuestionType;
  parentTopic?: string;
  briefTypes?: TaxonomyInterviewBriefType[];
  lexicalType?: CanonicalQuestionType;
  semanticType?: CanonicalQuestionType;
  expectedType: CanonicalQuestionType;
  expectedRelation: TaxonomyAdjudicationRelation;
  shouldAdjudicate: boolean;
}

export const TAXONOMY_ADJUDICATION_CORPUS: TaxonomyAdjudicationCorpusCase[] = [
  {
    id: "unknown-coding-design-algorithm",
    text: "Design an algorithm that finds every text file below a directory and write the code.",
    lexicalType: "unknown",
    semanticType: "coding",
    expectedType: "coding",
    expectedRelation: "new-parent",
    shouldAdjudicate: true,
  },
  {
    id: "general-to-aiml-linked-extension",
    text: "Now add a self-evolving recommendation agent to this food delivery app.",
    parentType: "general-system-design",
    parentTopic: "Design a food delivery platform",
    lexicalType: "general-system-design",
    semanticType: "ai-ml-system-design",
    expectedType: "ai-ml-system-design",
    expectedRelation: "linked-parent-extension",
    shouldAdjudicate: true,
  },
  {
    id: "independent-aiml-new-parent",
    text: "Next question: design a RAG system for a trip-planning assistant.",
    parentType: "general-system-design",
    parentTopic: "Design a ride sharing service",
    lexicalType: "unknown",
    semanticType: "ai-ml-system-design",
    expectedType: "ai-ml-system-design",
    expectedRelation: "new-parent",
    shouldAdjudicate: true,
  },
  {
    id: "coding-language-followup",
    text: "Can you implement the same solution in Java instead of Python?",
    parentType: "coding",
    parentTopic: "Sliding window maximum",
    lexicalType: "coding",
    semanticType: "coding",
    expectedType: "coding",
    expectedRelation: "followup-parent",
    shouldAdjudicate: false,
  },
  {
    id: "system-design-qps-followup",
    text: "What QPS should we provision for location updates?",
    parentType: "general-system-design",
    parentTopic: "Design an Uber-like app",
    lexicalType: "general-system-design",
    semanticType: "general-system-design",
    expectedType: "general-system-design",
    expectedRelation: "followup-parent",
    shouldAdjudicate: false,
  },
  {
    id: "aiml-field-child",
    text: "What is reciprocal rank fusion and why would we use it here?",
    parentType: "ai-ml-system-design",
    parentTopic: "Design hybrid retrieval for a RAG travel assistant",
    lexicalType: "unknown",
    semanticType: "field-knowledge",
    expectedType: "field-knowledge",
    expectedRelation: "child-probe",
    shouldAdjudicate: true,
  },
  {
    id: "behavioral-project-preference",
    text: "Tell me about a time you persuaded others. Use Agentic Memory if possible.",
    parentType: "project-deep-dive",
    lexicalType: "behavioral",
    semanticType: "behavioral",
    expectedType: "behavioral",
    expectedRelation: "new-parent",
    shouldAdjudicate: false,
  },
  {
    id: "resume-parent",
    text: "Okay, let's go back to the recommendation system architecture.",
    parentType: "ai-ml-system-design",
    parentTopic: "Design a recommendation system",
    lexicalType: "unknown",
    expectedType: "ai-ml-system-design",
    expectedRelation: "followup-parent",
    shouldAdjudicate: true,
  },
  {
    id: "chinese-general-system-design",
    text: "请设计一个高并发抢票系统，先澄清需求并估算 QPS。",
    lexicalType: "unknown",
    semanticType: "general-system-design",
    expectedType: "general-system-design",
    expectedRelation: "new-parent",
    shouldAdjudicate: true,
  },
  {
    id: "code-mixed-aiml",
    text: "How would you design 一个支持 hybrid search 的 enterprise RAG system?",
    lexicalType: "unknown",
    semanticType: "ai-ml-system-design",
    expectedType: "ai-ml-system-design",
    expectedRelation: "new-parent",
    shouldAdjudicate: true,
  },
  {
    id: "low-value-transition",
    text: "Yeah okay sounds good.",
    lexicalType: "unknown",
    expectedType: "unknown",
    expectedRelation: "none",
    shouldAdjudicate: false,
  },
  {
    id: "project-deep-dive-implementation",
    text: "How did you implement the consolidation pipeline in your Agentic Memory project?",
    parentType: "project-deep-dive",
    lexicalType: "project-deep-dive",
    semanticType: "project-deep-dive",
    expectedType: "project-deep-dive",
    expectedRelation: "followup-parent",
    shouldAdjudicate: false,
  },
];
