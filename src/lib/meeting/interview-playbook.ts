import type {
  MemoryQuestionType,
  MemoryRetrievalPolicy,
} from "@/lib/memory";
import type {
  InterviewSessionBrief,
  InterviewSessionContext,
  ScreenTaskKind,
  SelectedInterviewPlaybook,
  TaskAskFrame,
  TaskTopicDomain,
} from "./types.js";
import {
  formatCodingPlaybookPhaseContract,
  formatProjectDeepDivePhaseContract,
  resolvePlaybookRequiredArtifacts,
} from "./playbook-phase.js";
import {
  createInterviewPlaybookFromCatalog,
  isCatalogInterviewPlaybookCompatible,
  selectCommittedInterviewPlaybookFromCatalog,
  type CommittedInterviewPlaybookDisposition,
} from "./interview-playbook-catalog.js";
export type { CommittedInterviewPlaybookDisposition } from "./interview-playbook-catalog.js";
import {
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
  activeTaskPlaybook?: SelectedInterviewPlaybook;
  interviewSessionBrief?: InterviewSessionBrief;
  interviewSessionContext?: InterviewSessionContext;
}

export interface CommittedInterviewPlaybookSelection {
  playbook?: SelectedInterviewPlaybook;
  disposition: CommittedInterviewPlaybookDisposition;
  candidateQuestionType?: CanonicalQuestionType;
}

export function selectInterviewPlaybook({
  query = "",
  questionType,
  askFrame,
  topicDomain,
  projectAnchor,
  classifierConfidence,
  activeTaskPlaybook,
  interviewSessionBrief,
  interviewSessionContext,
}: SelectInterviewPlaybookInput): SelectedInterviewPlaybook | undefined {
  const normalizedQuestionType = resolvePlaybookQuestionType(
    questionType,
    query,
    interviewSessionBrief
  );

  if (
    activeTaskPlaybook &&
    isInterviewPlaybookCompatibleWithQuestionType(
      activeTaskPlaybook,
      normalizedQuestionType
    )
  ) {
    return {
      ...activeTaskPlaybook,
      reason: `${activeTaskPlaybook.reason}; reused active task playbook`,
    };
  }

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

  return createInterviewPlaybookFromCatalog({
    questionType: normalizedQuestionType,
    query,
    topicDomain,
    confidence,
    reason,
  });
}

export function selectInterviewPlaybookForCommittedType(
  input: Omit<
    SelectInterviewPlaybookInput,
    "questionType" | "activeTaskPlaybook"
  > & {
    questionType: CanonicalQuestionType;
    candidatePlaybook?: SelectedInterviewPlaybook;
  }
): CommittedInterviewPlaybookSelection {
  return selectCommittedInterviewPlaybookFromCatalog({
    questionType: input.questionType,
    query: input.query,
    askFrame: input.askFrame,
    topicDomain: input.topicDomain,
    projectAnchor: input.projectAnchor,
    confidence: input.classifierConfidence,
    candidatePlaybook: input.candidatePlaybook,
  });
}

export function isInterviewPlaybookCompatibleWithQuestionType(
  playbook: SelectedInterviewPlaybook | undefined,
  questionType: unknown
) {
  return isCatalogInterviewPlaybookCompatible(playbook, questionType);
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
    playbook.id === "project_deep_dive"
      ? formatProjectDeepDivePhaseContract(playbook.phase)
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

function resolvePlaybookQuestionType(
  questionType: ScreenTaskKind | MemoryQuestionType | undefined,
  query: string,
  interviewSessionBrief: InterviewSessionBrief | undefined
): CanonicalQuestionType | undefined {
  const normalized = normalizeCanonicalQuestionType(questionType);
  if (questionType !== undefined) return normalized;

  const inferred = inferCanonicalQuestionTypeFromText(query);
  if (inferred) return inferred;

  const configured = readSingleConcreteInterviewTypeOverride(
    interviewSessionBrief
  );
  if (configured) return configured;

  return normalized;
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
