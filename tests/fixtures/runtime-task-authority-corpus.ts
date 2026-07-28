import type {
  CanonicalQuestionType,
  QuestionTypeInferenceDecision,
} from "../../src/lib/meeting/task-taxonomy.js";
import type { InterviewTaskRelation } from "../../src/lib/meeting/types.js";

export interface ExplicitAskAuthorityFixture {
  id: string;
  text: string;
  currentDisposition: "answer-primary-ask" | "append-setup";
  expectedPrimaryAsk?: string;
  targetAdmission: true;
  expectedLocalType?: CanonicalQuestionType;
  expectedLegacyLocalType?: CanonicalQuestionType;
}

export interface AmbiguousTypeAuthorityFixture {
  id: string;
  text: string;
  currentLocalType?: CanonicalQuestionType;
  targetDisposition: "exact-high" | "abstain";
  targetType?: CanonicalQuestionType;
}

export interface LifecycleAuthorityFixture {
  id: string;
  hasExistingParent: boolean;
  existingParentQuestionType?: CanonicalQuestionType;
  candidateQuestionType?: CanonicalQuestionType;
  relation: InterviewTaskRelation;
  currentBranch:
    | "child-probe"
    | "new-parent"
    | "continue-parent"
    | "preserve";
  targetBranch:
    | "child-probe"
    | "new-parent"
    | "continue-parent"
    | "preserve";
}

export const EXPLICIT_ASK_AUTHORITY_CORPUS: ExplicitAskAuthorityFixture[] = [
  {
    id: "general-sd-start-with",
    text: "Now please design a ride-sharing system. Start with requirements and provide a high-level infrastructure whiteboard.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk: "design a ride-sharing system.",
    targetAdmission: true,
    expectedLocalType: "general-system-design",
  },
  {
    id: "general-sd-polite",
    text: "Could you design a distributed cache for a high-traffic service?",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk:
      "Could you design a distributed cache for a high-traffic service?",
    targetAdmission: true,
    expectedLocalType: "general-system-design",
  },
  {
    id: "general-sd-section-transition",
    text: "Let's move on to system design. Design a food delivery app like DoorDash.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk: "Design a food delivery app like DoorDash.",
    targetAdmission: true,
    expectedLocalType: "general-system-design",
  },
  {
    id: "general-sd-walk-through",
    text: "Walk me through designing a ride-sharing system.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk: "Walk me through designing a ride-sharing system.",
    targetAdmission: true,
    expectedLegacyLocalType: "project-deep-dive",
  },
  {
    id: "general-sd-high-level-design",
    text: "Give me a high-level design for a ticket selling system.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk:
      "Give me a high-level design for a ticket selling system.",
    targetAdmission: true,
    expectedLegacyLocalType: undefined,
    expectedLocalType: "general-system-design",
  },
  {
    id: "ai-ml-system-design",
    text: "Design a RAG service for a travel planning application.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk:
      "Design a RAG service for a travel planning application.",
    targetAdmission: true,
    expectedLocalType: "ai-ml-system-design",
  },
  {
    id: "coding-directive",
    text: "Implement a stack using two queues.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk: "Implement a stack using two queues.",
    targetAdmission: true,
    expectedLocalType: "coding",
  },
  {
    id: "behavioral-question",
    text: "Tell me about a time when you had to persuade a skeptical stakeholder.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk:
      "Tell me about a time when you had to persuade a skeptical stakeholder.",
    targetAdmission: true,
    expectedLocalType: "behavioral",
  },
  {
    id: "field-knowledge-question",
    text: "Explain how HNSW search works.",
    currentDisposition: "answer-primary-ask",
    expectedPrimaryAsk: "Explain how HNSW search works.",
    targetAdmission: true,
    expectedLocalType: "field-knowledge",
  },
  {
    id: "chinese-system-design",
    text: "请设计一个高并发的票务系统，并先澄清需求。",
    currentDisposition: "append-setup",
    targetAdmission: true,
    expectedLegacyLocalType: undefined,
    expectedLocalType: "general-system-design",
  },
];

export const AMBIGUOUS_TYPE_AUTHORITY_CORPUS: AmbiguousTypeAuthorityFixture[] = [
  {
    id: "walk-through-hypothetical-vs-project",
    text: "Walk me through designing a ride-sharing system.",
    currentLocalType: "project-deep-dive",
    targetDisposition: "abstain",
  },
  {
    id: "high-level-design-for",
    text: "Give me a high-level design for a ticket selling system.",
    currentLocalType: undefined,
    targetDisposition: "exact-high",
    targetType: "general-system-design",
  },
  {
    id: "bare-implementation",
    text: "How would you implement this feature?",
    currentLocalType: undefined,
    targetDisposition: "abstain",
  },
  {
    id: "model-concept-or-architecture",
    text: "Explain the model architecture.",
    currentLocalType: "field-knowledge",
    targetDisposition: "abstain",
  },
];

export const LIFECYCLE_AUTHORITY_CORPUS: LifecycleAuthorityFixture[] = [
  {
    id: "unknown-relation-must-not-create-parent",
    hasExistingParent: true,
    existingParentQuestionType: "general-system-design",
    candidateQuestionType: "coding",
    relation: "unknown",
    currentBranch: "new-parent",
    targetBranch: "preserve",
  },
  {
    id: "explicit-new-parent",
    hasExistingParent: true,
    existingParentQuestionType: "general-system-design",
    candidateQuestionType: "coding",
    relation: "new-parent",
    currentBranch: "new-parent",
    targetBranch: "new-parent",
  },
  {
    id: "explicit-child-probe",
    hasExistingParent: true,
    existingParentQuestionType: "ai-ml-system-design",
    candidateQuestionType: "field-knowledge",
    relation: "child-probe",
    currentBranch: "child-probe",
    targetBranch: "child-probe",
  },
  {
    id: "explicit-resume-parent",
    hasExistingParent: true,
    existingParentQuestionType: "ai-ml-system-design",
    candidateQuestionType: "ai-ml-system-design",
    relation: "resume-parent",
    currentBranch: "continue-parent",
    targetBranch: "continue-parent",
  },
  {
    id: "no-parent-with-parent-eligible-type",
    hasExistingParent: false,
    candidateQuestionType: "behavioral",
    relation: "unknown",
    currentBranch: "new-parent",
    targetBranch: "new-parent",
  },
  {
    id: "unknown-candidate-type",
    hasExistingParent: true,
    existingParentQuestionType: "general-system-design",
    candidateQuestionType: "unknown",
    relation: "unknown",
    currentBranch: "preserve",
    targetBranch: "preserve",
  },
];

export function summarizeLocalTypeDecision(
  decision: QuestionTypeInferenceDecision
) {
  return {
    type: decision.type,
    legacyType: decision.legacyType,
    certainty: decision.certainty,
    authorityReason: decision.authorityReason,
    conflictingTypes: [...decision.conflictingTypes],
    confidence: decision.confidence,
    margin: decision.margin,
    evidence: [...decision.evidence],
  };
}
