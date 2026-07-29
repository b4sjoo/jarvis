import type {
  MemoryInterviewFamily,
  MemoryQuestionType,
  MemoryRetrievalPolicy,
} from "@/lib/memory";
import type {
  InterviewSessionBrief,
  InterviewSessionContext,
  InterviewPlaybookId,
  InterviewPlaybookPhase,
  ScreenTaskKind,
  SelectedInterviewPlaybook,
  TaskAskFrame,
  TaskTopicDomain,
} from "./types.js";
import {
  formatCodingPlaybookPhaseContract,
  resolvePlaybookRequiredArtifacts,
} from "./playbook-phase.js";
import {
  allMemoryInterviewFamilies,
  inferCanonicalQuestionTypeFromText,
  normalizeCanonicalQuestionType,
  readSingleConcreteInterviewTypeOverride,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export interface SelectInterviewPlaybookInput {
  query?: string;
  questionType?: ScreenTaskKind | MemoryQuestionType;
  askFrame?: TaskAskFrame;
  topicDomain?: TaskTopicDomain;
  projectAnchor?: string;
  classifierConfidence?: number;
  activeScreenTask?: { playbook?: SelectedInterviewPlaybook };
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
}

export function selectInterviewPlaybook({
  query = "",
  questionType,
  askFrame,
  topicDomain,
  projectAnchor,
  classifierConfidence,
  activeScreenTask,
  interviewSessionBrief,
  interviewSessionContext,
}: SelectInterviewPlaybookInput): SelectedInterviewPlaybook | undefined {
  if (activeScreenTask?.playbook) {
    return {
      ...activeScreenTask.playbook,
      phase: "follow_up",
      reason: `${activeScreenTask.playbook.reason}; reused active task playbook`,
    };
  }

  const normalizedQuestionType = resolvePlaybookQuestionType(
    questionType,
    query,
    interviewSessionBrief
  );

  if (!normalizedQuestionType || normalizedQuestionType === "unknown") {
    return undefined;
  }

  const confidence = normalizeConfidence(classifierConfidence);
  const reason = buildSelectionReason({
    questionType: normalizedQuestionType,
    askFrame,
    topicDomain,
    projectAnchor,
    interviewSessionBrief,
    interviewSessionContext,
  });

  if (normalizedQuestionType === "behavioral") {
    return createPlaybook({
      id: "behavioral_story",
      label: "Behavioral Story",
      phase: "story_selection",
      questionType: normalizedQuestionType,
      confidence,
      reason,
      allowedFamilies: ["behavioral"],
      firstMove:
        "Select a supported first-person story, map it to the competency, then answer with action, tradeoff, impact, and learning.",
      clarifyingStrategy:
        "Ask only if the story choice is genuinely ambiguous; otherwise choose the safest supported story anchor.",
      outputContract:
        "中文思路 should name the story anchor and risk to avoid. Answer should be a compact first-person story with supported facts only.",
      followUpPolicy:
        "Follow-ups should adjust the same story angle, not restart with a different project unless the interviewer explicitly switches.",
      maxEntries: 6,
      maxChars: 6500,
    });
  }

  if (normalizedQuestionType === "coding") {
    return createPlaybook({
      id: "coding_algorithm",
      label: "Coding Algorithm",
      phase: "baseline_reasoning",
      questionType: normalizedQuestionType,
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

  if (normalizedQuestionType === "general-system-design") {
    return createPlaybook({
      id: "general_system_design",
      label: "General System Design",
      phase: "requirement_clarification",
      questionType: "general-system-design",
      confidence,
      reason,
      allowedFamilies: ["system-design"],
      firstMove:
        "Frame the core requirement, ask 2-3 material questions covering enough traffic information to estimate QPS plus the highest-value correctness/availability constraint, and create a provisional high-level Whiteboard before committing to details.",
      clarifyingStrategy:
        "Prefer concrete requirement questions: DAU/actions/peak factor, consistency vs latency, single-region vs global, and out-of-scope boundaries.",
      outputContract:
        "During requirement clarification, Answer is a short framing plus 2-3 high-value questions and Whiteboard is a PROVISIONAL request/data-path skeleton with open constraints. After readiness, Approach and Whiteboard evolve through APIs/data model, architecture, scaling, correctness, reliability, and observability.",
      followUpPolicy:
        "Follow-ups should update the affected phase: capacity, data model, write path, consistency, failure mode, or deep dive subsystem.",
      maxEntries: 6,
      maxChars: 6500,
    });
  }

  if (normalizedQuestionType === "ai-ml-system-design") {
    const subtype = inferAimlSystemDesignSubtype(query, topicDomain);
    return createPlaybook({
      id: "aiml_system_design",
      label: "AI/ML System Design",
      phase: "requirement_clarification",
      subtype,
      questionType: normalizedQuestionType,
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

  if (normalizedQuestionType === "project-deep-dive") {
    return createPlaybook({
      id: "project_deep_dive",
      label: "Project Deep Dive",
      phase: "project_narrative",
      questionType: normalizedQuestionType,
      confidence,
      reason,
      allowedFamilies: ["project-deep-dive", "ai-ml-system-design", "system-design"],
      firstMove:
        "Anchor on a real project, state my role, then explain problem, architecture, hard decision, validation, impact, and lesson.",
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

  if (normalizedQuestionType === "field-knowledge") {
    return createPlaybook({
      id: "aiml_field_knowledge",
      label: "AIML Field Knowledge",
      phase: "concept_explanation",
      questionType: normalizedQuestionType,
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

export function formatInterviewPlaybookForPrompt(
  playbook: SelectedInterviewPlaybook | undefined
) {
  if (!playbook) {
    return "No interview playbook was selected. Use the default Jarvis task contract.";
  }

  const requiredArtifacts = resolvePlaybookRequiredArtifacts({
    questionType: playbook.questionType,
    playbookId: playbook.id,
    phase: playbook.phase,
  });
  return [
    `id: ${playbook.id}`,
    `label: ${playbook.label}`,
    `phase: ${playbook.phase}`,
    playbook.subtype ? `subtype: ${playbook.subtype}` : undefined,
    `questionType: ${playbook.questionType}`,
    `confidence: ${playbook.confidence.toFixed(2)}`,
    `reason: ${playbook.reason}`,
    `memoryPolicy: ${formatMemoryPolicy(playbook.memoryPolicy)}`,
    `firstMove: ${playbook.firstMove}`,
    `clarifyingStrategy: ${playbook.clarifyingStrategy}`,
    `outputContract: ${playbook.outputContract}`,
    `followUpPolicy: ${playbook.followUpPolicy}`,
    `requiredArtifacts: ${requiredArtifacts.join(", ")}`,
    playbook.id === "coding_algorithm"
      ? formatCodingPlaybookPhaseContract(playbook.phase)
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function withInterviewPlaybookPhase(
  playbook: SelectedInterviewPlaybook | undefined,
  phase: SelectedInterviewPlaybook["phase"] | undefined
) {
  if (!playbook || !phase || playbook.phase === phase) return playbook;
  return { ...playbook, phase };
}

export function formatInterviewPlaybookForTrace(
  playbook: SelectedInterviewPlaybook | undefined
) {
  if (!playbook) {
    return {
      playbookId: undefined,
      playbookLabel: undefined,
      playbookPhase: undefined,
      playbookSubtype: undefined,
      playbookConfidence: undefined,
      playbookReason: undefined,
      playbookAllowedFamilies: undefined,
      playbookBlockedFamilies: undefined,
    };
  }

  return {
    playbookId: playbook.id,
    playbookLabel: playbook.label,
    playbookPhase: playbook.phase,
    playbookSubtype: playbook.subtype,
    playbookConfidence: playbook.confidence,
    playbookReason: playbook.reason,
    playbookAllowedFamilies: playbook.memoryPolicy.allowedFamilies,
    playbookBlockedFamilies: playbook.memoryPolicy.blockedFamilies,
    playbookRequiredArtifacts: resolvePlaybookRequiredArtifacts({
      questionType: playbook.questionType,
      playbookId: playbook.id,
      phase: playbook.phase,
    }),
  };
}

function createPlaybook({
  id,
  label,
  phase,
  subtype,
  questionType,
  confidence,
  reason,
  allowedFamilies,
  firstMove,
  clarifyingStrategy,
  outputContract,
  followUpPolicy,
  maxEntries,
  maxChars,
}: {
  id: InterviewPlaybookId;
  label: string;
  phase: InterviewPlaybookPhase;
  subtype?: string;
  questionType: CanonicalQuestionType;
  confidence: number;
  reason: string;
  allowedFamilies: MemoryInterviewFamily[];
  firstMove: string;
  clarifyingStrategy: string;
  outputContract: string;
  followUpPolicy: string;
  maxEntries: number;
  maxChars: number;
}): SelectedInterviewPlaybook {
  const blockedFamilies = allMemoryInterviewFamilies().filter(
    (family) => !allowedFamilies.includes(family)
  );

  return {
    id,
    label,
    phase,
    subtype,
    questionType,
    confidence,
    reason,
    memoryPolicy: {
      id,
      allowedFamilies,
      blockedFamilies,
      maxEntries,
      maxChars,
      perEntryMaxChars: 1200,
    },
    firstMove,
    clarifyingStrategy,
    outputContract,
    followUpPolicy,
  };
}

function resolvePlaybookQuestionType(
  questionType: ScreenTaskKind | MemoryQuestionType | undefined,
  query: string,
  interviewSessionBrief: InterviewSessionBrief | undefined
): CanonicalQuestionType | undefined {
  const normalized = normalizeCanonicalQuestionType(questionType);
  if (normalized && normalized !== "unknown") return normalized;

  const inferred = inferCanonicalQuestionTypeFromText(query);
  if (inferred) return inferred;

  const configured = readSingleConcreteInterviewTypeOverride(
    interviewSessionBrief
  );
  if (configured) return configured;

  return normalized;
}

function inferAimlSystemDesignSubtype(
  query: string,
  topicDomain: TaskTopicDomain | undefined
) {
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

function normalizeConfidence(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.72;
  return Math.max(0.3, Math.min(0.98, value));
}

function buildSelectionReason({
  questionType,
  askFrame,
  topicDomain,
  projectAnchor,
  interviewSessionBrief,
  interviewSessionContext,
}: {
  questionType: CanonicalQuestionType;
  askFrame?: TaskAskFrame;
  topicDomain?: TaskTopicDomain;
  projectAnchor?: string;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
}) {
  const parts = [`questionType=${questionType}`];
  if (askFrame && askFrame !== "unknown") parts.push(`askFrame=${askFrame}`);
  if (topicDomain && topicDomain !== "unknown") {
    parts.push(`topicDomain=${topicDomain}`);
  }
  if (projectAnchor) parts.push(`projectAnchor=${projectAnchor}`);
  if (interviewSessionBrief?.interviewTypes.length) {
    parts.push(`briefTypes=${interviewSessionBrief.interviewTypes.join("+")}`);
  }
  if (interviewSessionContext?.targetCompany?.value) {
    parts.push(`company=${interviewSessionContext.targetCompany.value}`);
  }
  return parts.join("; ");
}

function formatMemoryPolicy(policy: MemoryRetrievalPolicy) {
  const allow = policy.allowedFamilies?.join(", ") || "all";
  const block = policy.blockedFamilies?.join(", ") || "none";
  return `allow=[${allow}], block=[${block}], maxEntries=${policy.maxEntries}, maxChars=${policy.maxChars}`;
}
