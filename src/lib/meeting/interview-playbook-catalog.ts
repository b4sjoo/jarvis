export type InterviewPlaybookCatalogQuestionType =
  | "behavioral"
  | "coding"
  | "general-system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "field-knowledge"
  | "unknown";

export type InterviewPlaybookCatalogId =
  | "behavioral_story"
  | "coding_algorithm"
  | "general_system_design"
  | "aiml_system_design"
  | "project_deep_dive"
  | "aiml_field_knowledge";

export type InterviewPlaybookCatalogPhase =
  | "story_selection"
  | "baseline_reasoning"
  | "optimized_pseudocode"
  | "implementation_validation"
  | "solution_planning"
  | "requirement_clarification"
  | "design_framing"
  | "project_narrative"
  | "architecture_decision"
  | "validation_reliability"
  | "impact_lessons"
  | "concept_explanation"
  | "follow_up";

export type InterviewPlaybookCatalogFamily =
  | "behavioral"
  | "coding"
  | "system-design"
  | "ai-ml-system-design"
  | "project-deep-dive";

export type CommittedInterviewPlaybookDisposition =
  | "selected-from-committed-type"
  | "retained-compatible-playbook"
  | "reselected-incompatible-playbook"
  | "no-playbook-for-unknown-type";

export interface CatalogInterviewPlaybook {
  id: InterviewPlaybookCatalogId;
  label: string;
  phase: InterviewPlaybookCatalogPhase;
  subtype?: string;
  questionType: InterviewPlaybookCatalogQuestionType;
  confidence: number;
  reason: string;
  memoryPolicy: {
    id: string;
    allowedFamilies?: InterviewPlaybookCatalogFamily[];
    blockedFamilies?: InterviewPlaybookCatalogFamily[];
    maxEntries?: number;
    maxChars?: number;
    perEntryMaxChars?: number;
  };
  firstMove: string;
  clarifyingStrategy: string;
  outputContract: string;
  followUpPolicy: string;
}

export interface CommittedInterviewPlaybookSelection {
  playbook?: CatalogInterviewPlaybook;
  disposition: CommittedInterviewPlaybookDisposition;
  candidateQuestionType?: InterviewPlaybookCatalogQuestionType;
}

export function selectCommittedInterviewPlaybookFromCatalog(input: {
  questionType: InterviewPlaybookCatalogQuestionType;
  query?: string;
  askFrame?: string;
  topicDomain?: string;
  projectAnchor?: string;
  confidence?: number;
  candidatePlaybook?: CatalogInterviewPlaybook;
}): CommittedInterviewPlaybookSelection {
  const candidateQuestionType = normalizeCatalogQuestionType(
    input.candidatePlaybook?.questionType
  );
  if (
    isCatalogInterviewPlaybookCompatible(
      input.candidatePlaybook,
      input.questionType
    )
  ) {
    return {
      playbook: input.candidatePlaybook,
      disposition: "retained-compatible-playbook",
      candidateQuestionType,
    };
  }
  if (input.questionType === "unknown") {
    return {
      disposition: "no-playbook-for-unknown-type",
      candidateQuestionType,
    };
  }

  const reason = [
    `questionType=${input.questionType}`,
    "authority=committed-settlement",
    input.askFrame && input.askFrame !== "unknown"
      ? `askFrame=${input.askFrame}`
      : undefined,
    input.topicDomain && input.topicDomain !== "unknown"
      ? `topicDomain=${input.topicDomain}`
      : undefined,
    input.projectAnchor
      ? `projectAnchor=${input.projectAnchor}`
      : undefined,
    input.candidatePlaybook
      ? "reselected after committed response-owner mismatch"
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const playbook = createInterviewPlaybookFromCatalog({
    questionType: input.questionType,
    query: input.query,
    topicDomain: input.topicDomain,
    confidence: normalizeCatalogConfidence(input.confidence),
    reason,
  });
  return {
    playbook,
    disposition: input.candidatePlaybook
      ? "reselected-incompatible-playbook"
      : "selected-from-committed-type",
    candidateQuestionType,
  };
}

export function isCatalogInterviewPlaybookCompatible(
  playbook: CatalogInterviewPlaybook | undefined,
  questionType: unknown
) {
  if (!playbook) return false;
  const normalizedQuestionType = normalizeCatalogQuestionType(questionType);
  return (
    Boolean(normalizedQuestionType) &&
    normalizeCatalogQuestionType(playbook.questionType) ===
      normalizedQuestionType
  );
}

export function createInterviewPlaybookFromCatalog(input: {
  questionType: InterviewPlaybookCatalogQuestionType;
  query?: string;
  topicDomain?: string;
  confidence: number;
  reason: string;
}): CatalogInterviewPlaybook | undefined {
  const { questionType, confidence, reason } = input;

  if (questionType === "behavioral") {
    return createPlaybook({
      id: "behavioral_story",
      label: "Behavioral Story",
      phase: "story_selection",
      questionType,
      confidence,
      reason,
      allowedFamilies: ["behavioral"],
      firstMove:
        "Use the single supported personal story selected by the Behavioral family contract. Adapt its emphasis to the question, then answer with action, tradeoff, impact, and learning without changing story identity.",
      clarifyingStrategy:
        "Ask only if the story choice is genuinely ambiguous; otherwise choose the safest supported story anchor.",
      outputContract:
        "中文思路 should name the selected story anchor and the factual risk to avoid. Answer should be a speakable 60-90 second first-person STAR using supported facts only; keep deeper tradeoff, failure, and retrospective material for follow-ups.",
      followUpPolicy:
        "Follow-ups should preserve the committed story anchor and select the relevant result, tradeoff, failure-recovery, or retrospective angle. Do not restart with a different story unless the interviewer explicitly switches topics.",
      maxEntries: 6,
      maxChars: 6500,
    });
  }

  if (questionType === "coding") {
    return createPlaybook({
      id: "coding_algorithm",
      label: "Coding Algorithm",
      phase: "baseline_reasoning",
      questionType,
      confidence,
      reason,
      allowedFamilies: ["coding"],
      firstMove:
        "Restate the focused problem and language, explain the simplest correct baseline with a small dry run, then optimize and implement only when the interviewer or user advances the phase.",
      clarifyingStrategy:
        "Ask only when a constraint changes the optimal algorithm, input format, or requested language.",
      outputContract:
        "中文思路 first in Chinese. Question, Answer, Approach, Complexity, Clarifying question, and Clarifying options should default to meeting-ready English. Follow the current Coding phase contract; Code belongs only in Code and must use the selected/requested programming language.",
      followUpPolicy:
        "If a follow-up is non-coding, keep existing coding artifacts unless the task is reset or the follow-up explicitly changes implementation or complexity.",
      maxEntries: 4,
      maxChars: 4200,
    });
  }

  if (questionType === "general-system-design") {
    return createPlaybook({
      id: "general_system_design",
      label: "General System Design",
      phase: "requirement_clarification",
      questionType,
      confidence,
      reason,
      allowedFamilies: ["system-design"],
      firstMove:
        "Frame the core requirement, ask 2-3 material questions covering enough traffic information to estimate QPS plus the highest-value correctness/availability constraint, and create a provisional high-level Whiteboard before committing to details.",
      clarifyingStrategy:
        "Prefer concrete requirement questions: DAU/actions/peak factor, consistency vs latency, single-region vs global, and out-of-scope boundaries.",
      outputContract:
        "During requirement clarification, Answer is a short framing plus 2-3 high-value questions and Whiteboard is a PROVISIONAL request/data-path skeleton with open constraints. Numeric QPS requires direct throughput or a request/action time basis; inventory, user count, read/write ratio, or peak factor alone is insufficient. Otherwise ask for the missing time basis or state explicit mutable assumptions before calculating. After readiness, Approach and Whiteboard evolve through APIs/data model, architecture, scaling, correctness, reliability, and observability.",
      followUpPolicy:
        "Follow-ups should update the affected phase: capacity, data model, write path, consistency, failure mode, or deep dive subsystem.",
      maxEntries: 6,
      maxChars: 6500,
    });
  }

  if (questionType === "ai-ml-system-design") {
    return createPlaybook({
      id: "aiml_system_design",
      label: "AI/ML System Design",
      phase: "requirement_clarification",
      subtype: inferAimlSystemDesignSubtype(
        input.query ?? "",
        input.topicDomain
      ),
      questionType,
      confidence,
      reason,
      allowedFamilies: ["ai-ml-system-design", "system-design"],
      firstMove:
        "Clarify the decision/use case and ask 2-3 architecture-changing questions about success evaluation plus the highest-value data, serving, feedback, or safety boundary. Create a provisional high-level Whiteboard before giving a full design.",
      clarifyingStrategy:
        "Ask for target metric, traffic/latency, data freshness, evaluation standard, feedback loop, safety/privacy boundary, or rollout constraint.",
      outputContract:
        "During requirement clarification, Answer gives the design framing plus 2-3 material questions and Whiteboard is a PROVISIONAL data/context-to-decision-to-feedback skeleton with open constraints. After readiness, evolve data, model/retrieval, serving, eval, monitoring, rollout, and tradeoffs.",
      followUpPolicy:
        "Follow-ups should update the relevant AI/ML layer: data, retrieval, model, orchestration, eval, observability, safety, or rollout.",
      maxEntries: 6,
      maxChars: 7000,
    });
  }

  if (questionType === "project-deep-dive") {
    return createPlaybook({
      id: "project_deep_dive",
      label: "Project Deep Dive",
      phase: "project_narrative",
      questionType,
      confidence,
      reason,
      allowedFamilies: [
        "project-deep-dive",
        "ai-ml-system-design",
        "system-design",
      ],
      firstMove:
        "Anchor on one real project and give a 30-45 second introduction covering the problem, previous limitation, my role and contribution, and supported outcome.",
      clarifyingStrategy:
        "If the prompt mixes past project and future improvement, ask whether to discuss the existing implementation first or propose a future design.",
      outputContract:
        "Answer must be fact-bound and first-person. 中文思路 should name the project anchor, role, design decision, tradeoff, validation, and impact boundary.",
      followUpPolicy:
        "Follow-ups should drill into architecture, tradeoff, debugging, metrics, failure, rollout, or future work for the same project.",
      maxEntries: 7,
      maxChars: 7600,
    });
  }

  if (questionType === "field-knowledge") {
    return createPlaybook({
      id: "aiml_field_knowledge",
      label: "AIML Field Knowledge",
      phase: "concept_explanation",
      questionType,
      confidence,
      reason,
      allowedFamilies: ["ai-ml-system-design", "system-design"],
      firstMove:
        "Give a concise definition or comparison, then explain when it is used, the key tradeoff, and one practical engineering implication.",
      clarifyingStrategy:
        "Ask only if the question could mean two materially different technical concepts or levels of depth.",
      outputContract:
        "Answer should be meeting-ready and compact. Approach should separate concept, mechanism, tradeoff, and practical implication.",
      followUpPolicy:
        "Follow-ups should deepen the requested axis: math, implementation, system design extension, eval, or tradeoff.",
      maxEntries: 5,
      maxChars: 5600,
    });
  }

  return undefined;
}

function createPlaybook(input: {
  id: InterviewPlaybookCatalogId;
  label: string;
  phase: InterviewPlaybookCatalogPhase;
  subtype?: string;
  questionType: InterviewPlaybookCatalogQuestionType;
  confidence: number;
  reason: string;
  allowedFamilies: InterviewPlaybookCatalogFamily[];
  firstMove: string;
  clarifyingStrategy: string;
  outputContract: string;
  followUpPolicy: string;
  maxEntries: number;
  maxChars: number;
}): CatalogInterviewPlaybook {
  const blockedFamilies = ALL_INTERVIEW_FAMILIES.filter(
    (family) => !input.allowedFamilies.includes(family)
  );
  return {
    id: input.id,
    label: input.label,
    phase: input.phase,
    subtype: input.subtype,
    questionType: input.questionType,
    confidence: input.confidence,
    reason: input.reason,
    memoryPolicy: {
      id: input.id,
      allowedFamilies: input.allowedFamilies,
      blockedFamilies,
      maxEntries: input.maxEntries,
      maxChars: input.maxChars,
      perEntryMaxChars: 1200,
    },
    firstMove: input.firstMove,
    clarifyingStrategy: input.clarifyingStrategy,
    outputContract: input.outputContract,
    followUpPolicy: input.followUpPolicy,
  };
}

function inferAimlSystemDesignSubtype(query: string, topicDomain?: string) {
  const normalized = query.toLowerCase();
  if (
    topicDomain === "agentic-ai" ||
    /\b(rag|retrieval augmented|agent|tool use|agentic|memory)\b/.test(
      normalized
    )
  ) {
    return "rag_agent_system_design";
  }
  if (/\b(llm|prompt|fine-tun|generation|chatbot|assistant)\b/.test(normalized)) {
    return "genai_llm_app_design";
  }
  return "traditional_ml_system_design";
}

function normalizeCatalogQuestionType(
  value: unknown
): InterviewPlaybookCatalogQuestionType | undefined {
  if (
    value === "behavioral" ||
    value === "coding" ||
    value === "general-system-design" ||
    value === "ai-ml-system-design" ||
    value === "project-deep-dive" ||
    value === "field-knowledge" ||
    value === "unknown"
  ) {
    return value;
  }
  if (value === "system-design") return "general-system-design";
  return undefined;
}

function normalizeCatalogConfidence(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.72;
  return Math.max(0.3, Math.min(0.98, value));
}

const ALL_INTERVIEW_FAMILIES: InterviewPlaybookCatalogFamily[] = [
  "behavioral",
  "coding",
  "system-design",
  "ai-ml-system-design",
  "project-deep-dive",
];
