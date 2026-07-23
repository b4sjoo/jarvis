import type {
  MemoryQuestionType,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "@/lib/memory";
import {
  getRuntimeFactAnchorLabel,
  resolveRetrievedMemoryRole,
} from "../memory/runtime-role.js";
import type {
  FactAnchorDecision,
  FactAnchorRequiredFor,
  InterviewSessionBrief,
  PersonalEvidenceDecision,
  PersonalEvidenceGuardrailMode,
  PersonalEvidenceSource,
  PersonalEvidenceStatusDomain,
  ProjectBindingDecision,
} from "./types";
import { detectPersonalEvidenceRequirement } from "./personal-evidence-guardrail.js";

const GENERIC_ANCHOR_TITLES = new Set([
  "behavioral story",
  "behavioral interview story selector",
  "project deep dive",
  "general system design",
  "ai/ml system design",
  "coding algorithm",
  "field knowledge",
]);

const PERSONAL_PROFILE_ENTRY_TYPES = new Set([
  "profile",
  "preference",
  "resume_fact",
]);

const PERSONAL_STATUS_DOMAIN_TERMS: Record<
  PersonalEvidenceStatusDomain,
  string[]
> = {
  "health-status": [
    "health",
    "condition",
    "recovery",
    "recover",
    "symptom",
    "palpitation",
    "pain",
    "injury",
    "illness",
    "medical",
    "treatment",
    "heart",
  ],
  "work-authorization": [
    "work authorization",
    "authorized",
    "visa",
    "sponsorship",
    "sponsor",
    "work permit",
  ],
  "location-relocation": [
    "location",
    "located",
    "relocate",
    "relocation",
    "remote",
    "onsite",
    "hybrid",
  ],
  "availability-start-date": [
    "availability",
    "available",
    "start date",
    "notice period",
    "notice",
  ],
  compensation: [
    "compensation",
    "salary",
    "pay",
    "total compensation",
    "base",
    "equity",
  ],
  "employment-status": [
    "employment",
    "employed",
    "working at",
    "working for",
    "current role",
  ],
};

export interface ConfirmedMeFact {
  id: string;
  text: string;
}

export interface BuildFactAnchorDecisionInput {
  questionType?: MemoryQuestionType;
  questionText?: string;
  personalEvidenceGuardrailMode?: PersonalEvidenceGuardrailMode;
  memoryContext?: MemoryRetrievalResult | null;
  interviewSessionBrief?: InterviewSessionBrief;
  confirmedMeFacts?: ConfirmedMeFact[];
  activeFactAnchors?: string[];
  projectAnchor?: string;
  personalEvidenceDecision?: PersonalEvidenceDecision;
  projectBindingDecision?: ProjectBindingDecision;
}

export function restrictMemoryContextForPersonalEvidence(
  memoryContext: MemoryRetrievalResult | undefined,
  personalEvidence: PersonalEvidenceDecision,
  questionText?: string
) {
  if (
    !memoryContext ||
    !personalEvidence.enforced ||
    personalEvidence.requirement !== "personal-logistics"
  ) {
    return memoryContext;
  }

  const entries = memoryContext.entries.filter(
    (item) =>
      PERSONAL_PROFILE_ENTRY_TYPES.has(item.entry.type) &&
      isRelevantPersonalEvidence(
        [
          item.entry.title,
          item.entry.summary,
          item.entry.content,
          ...item.entry.tags,
          ...item.entry.keywords,
        ].join(" "),
        questionText,
        personalEvidence.statusDomain
      )
  );
  const contextText = formatPersonalProfileMemoryContext(entries);

  return {
    ...memoryContext,
    entries,
    contextText,
    totalChars: contextText.length,
    eligibleCount: entries.length,
    overlaySelection: undefined,
  };
}

export function buildFactAnchorDecision({
  questionType,
  questionText,
  personalEvidenceGuardrailMode = "enforcement",
  memoryContext,
  interviewSessionBrief,
  confirmedMeFacts = [],
  activeFactAnchors = [],
  projectAnchor,
  personalEvidenceDecision,
  projectBindingDecision,
}: BuildFactAnchorDecisionInput): FactAnchorDecision {
  const personalEvidence =
    personalEvidenceDecision ??
    detectPersonalEvidenceRequirement({
      questionText,
      questionType,
      mode: personalEvidenceGuardrailMode,
    });
  const requiredFor = getFactAnchorRequirement(questionType, personalEvidence);
  if (requiredFor === "none") {
    return {
      state: "not-required",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: [],
      action: "answer-with-anchor",
      personalEvidence,
      selectedPersonalEvidenceSources: [],
      unsupportedClaimRisk:
        personalEvidence.mode === "shadow" &&
        personalEvidence.confidenceTier === "high" &&
        personalEvidence.requirement !== "not-required"
          ? "shadow-observed"
          : "none",
    };
  }

  if (requiredFor === "personal-logistics") {
    return buildPersonalStatusFactDecision({
      questionText,
      personalEvidence,
      memoryContext,
      interviewSessionBrief,
      confirmedMeFacts,
    });
  }

  if (
    requiredFor === "project-deep-dive" &&
    projectBindingDecision?.action === "needs-selection"
  ) {
    const candidateTitles = projectBindingDecision.candidates.map(
      (candidate) => candidate.projectName
    );
    return {
      state: candidateTitles.length ? "weak-anchor" : "no-anchor",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: candidateTitles,
      action: candidateTitles.length
        ? "offer-supported-choices"
        : "ask-clarification",
      missingAnchorReason: candidateTitles.length
        ? "Multiple eligible project evidence sets were retrieved, so Jarvis must not choose one silently."
        : "No eligible project evidence was retrieved for the requested first-person project answer.",
      personalEvidence,
      selectedPersonalEvidenceSources: [],
      unsupportedClaimRisk: "high",
    };
  }

  const memoryAnchors = collectFactAnchorEntries(
    memoryContext?.entries ?? [],
    projectBindingDecision
  );
  const activeAnchors = projectBindingDecision?.binding
    ? normalizeActiveFactAnchors(activeFactAnchors).filter((anchor) =>
        activeAnchorMatchesBinding(anchor, projectBindingDecision.binding!)
      )
    : normalizeActiveFactAnchors(activeFactAnchors);
  const supportedAnchorIds = uniqueStrings([
    ...memoryAnchors.map((item) => item.entry.id),
    ...activeAnchors,
  ]);
  const supportedAnchorTitles = uniqueStrings([
    ...memoryAnchors.map(formatMemoryAnchorTitle),
    ...activeAnchors,
  ]);

  if (memoryAnchors.length || activeAnchors.length) {
    return {
      state: "strong-anchor",
      requiredFor,
      supportedAnchorIds,
      supportedAnchorTitles,
      selectedAnchorId: memoryAnchors[0]?.entry.id ?? activeAnchors[0],
      action: "answer-with-anchor",
      personalEvidence,
      selectedPersonalEvidenceSources: [],
      unsupportedClaimRisk: "guarded",
    };
  }

  const selectedNonAnchorEntries = memoryContext?.entries.length ?? 0;
  if (selectedNonAnchorEntries > 0) {
    return {
      state: "weak-anchor",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: [],
      action: "answer-with-caveats",
      missingAnchorReason:
        "Memory retrieval found guidance or rubrics, but no concrete project/story fact anchor.",
      personalEvidence,
      selectedPersonalEvidenceSources: [],
      unsupportedClaimRisk: "high",
    };
  }

  const projectHint = projectAnchor?.trim();
  return {
    state: "no-anchor",
    requiredFor,
    supportedAnchorIds: [],
    supportedAnchorTitles: projectHint ? [projectHint] : [],
    action: projectHint ? "offer-supported-choices" : "ask-clarification",
    missingAnchorReason: projectHint
      ? `The task mentions "${projectHint}", but no curated memory fact anchor was retrieved for it.`
      : "No curated memory fact anchor was retrieved for this behavioral or project deep-dive answer.",
    personalEvidence,
    selectedPersonalEvidenceSources: [],
    unsupportedClaimRisk: "high",
  };
}

export function formatFactAnchorDecisionForPrompt(
  decision: FactAnchorDecision | undefined
) {
  if (!decision) return "No fact-anchor decision was computed.";

  return [
    `State: ${decision.state}`,
    `Required for: ${decision.requiredFor}`,
    `Action: ${decision.action}`,
    `Personal evidence requirement: ${decision.personalEvidence.requirement}`,
    `Personal evidence confidence: ${decision.personalEvidence.confidenceTier} (${decision.personalEvidence.confidence.toFixed(2)})`,
    `Personal evidence mode: ${decision.personalEvidence.mode}`,
    `Personal evidence enforced: ${decision.personalEvidence.enforced}`,
    decision.personalEvidence.statusDomain
      ? `Personal status domain: ${decision.personalEvidence.statusDomain}`
      : undefined,
    decision.personalEvidence.allowedEvidenceSources.length
      ? `Allowed personal evidence sources: ${decision.personalEvidence.allowedEvidenceSources.join(", ")}`
      : undefined,
    decision.selectedPersonalEvidenceSources.length
      ? `Selected personal evidence sources: ${decision.selectedPersonalEvidenceSources.join(", ")}`
      : undefined,
    decision.personalEvidence.signals.length
      ? `Personal evidence signals: ${decision.personalEvidence.signals.join(", ")}`
      : undefined,
    decision.personalEvidence.counterSignals.length
      ? `Hypothetical counter-signals: ${decision.personalEvidence.counterSignals.join(", ")}`
      : undefined,
    `Unsupported claim risk: ${decision.unsupportedClaimRisk}`,
    decision.supportedAnchorTitles.length
      ? `Supported anchors: ${decision.supportedAnchorTitles.join(", ")}`
      : "Supported anchors: none",
    decision.selectedAnchorId
      ? `Selected anchor id: ${decision.selectedAnchorId}`
      : undefined,
    decision.missingAnchorReason
      ? `Reason: ${decision.missingAnchorReason}`
      : undefined,
    decision.personalEvidence.requirement === "personal-logistics"
      ? "Personal status/logistics rule: use only the listed Interview Brief, profile-memory, or confirmed-Me anchors. Never borrow project/story facts or infer recovery/status. If the needed fact is absent, ask for it or stay explicitly fact-neutral."
      : undefined,
    decision.personalEvidence.enforced
      ? "Classifier-independent rule: enforce Action even if the question type is coding, field knowledge, system design, or unknown. Question wording and suggested alternatives are not evidence."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatFactAnchorDecisionForTrace(
  decision: FactAnchorDecision | undefined
): Record<string, unknown> {
  if (!decision) return {};

  return {
    factAnchorState: decision.state,
    factAnchorRequiredFor: decision.requiredFor,
    factAnchorAction: decision.action,
    factAnchorSupportedIds: decision.supportedAnchorIds,
    factAnchorSupportedTitles: decision.supportedAnchorTitles,
    factAnchorSelectedId: decision.selectedAnchorId,
    factAnchorMissingReason: decision.missingAnchorReason,
    personalEvidenceRequirement: decision.personalEvidence.requirement,
    personalEvidenceConfidence: decision.personalEvidence.confidence,
    personalEvidenceConfidenceTier: decision.personalEvidence.confidenceTier,
    personalEvidenceSignals: decision.personalEvidence.signals,
    personalEvidenceCounterSignals: decision.personalEvidence.counterSignals,
    personalEvidenceStatusDomain: decision.personalEvidence.statusDomain,
    personalEvidenceAllowedSources:
      decision.personalEvidence.allowedEvidenceSources,
    personalEvidenceSelectedSources: decision.selectedPersonalEvidenceSources,
    personalEvidenceGuardrailMode: decision.personalEvidence.mode,
    personalEvidenceEnforced: decision.personalEvidence.enforced,
    unsupportedClaimRisk: decision.unsupportedClaimRisk,
  };
}

function getFactAnchorRequirement(
  questionType: MemoryQuestionType | undefined,
  personalEvidence: FactAnchorDecision["personalEvidence"]
): FactAnchorRequiredFor {
  if (personalEvidence.enforced) {
    if (personalEvidence.requirement === "personal-logistics") {
      return "personal-logistics";
    }
    return personalEvidence.requirement === "autobiographical-behavioral"
      ? "behavioral"
      : "project-deep-dive";
  }
  if (questionType === "behavioral") return "behavioral";
  if (questionType === "project-deep-dive") return "project-deep-dive";
  return "none";
}

function buildPersonalStatusFactDecision({
  questionText,
  personalEvidence,
  memoryContext,
  interviewSessionBrief,
  confirmedMeFacts,
}: {
  questionText?: string;
  personalEvidence: PersonalEvidenceDecision;
  memoryContext?: MemoryRetrievalResult | null;
  interviewSessionBrief?: InterviewSessionBrief;
  confirmedMeFacts: ConfirmedMeFact[];
}): FactAnchorDecision {
  const anchors = [
    ...collectInterviewBriefPersonalAnchors(
      interviewSessionBrief,
      questionText,
      personalEvidence.statusDomain
    ),
    ...collectProfileMemoryAnchors(
      memoryContext?.entries ?? [],
      questionText,
      personalEvidence.statusDomain
    ),
    ...collectConfirmedMeAnchors(
      confirmedMeFacts,
      questionText,
      personalEvidence.statusDomain
    ),
  ];
  const supportedAnchorIds = uniqueStrings(anchors.map((anchor) => anchor.id));
  const supportedAnchorTitles = uniqueStrings(
    anchors.map((anchor) => anchor.title)
  );
  const selectedPersonalEvidenceSources = uniqueStrings(
    anchors.map((anchor) => anchor.source)
  ) as PersonalEvidenceSource[];

  if (anchors.length) {
    return {
      state: "strong-anchor",
      requiredFor: "personal-logistics",
      supportedAnchorIds,
      supportedAnchorTitles,
      selectedAnchorId: anchors[0].id,
      action: "answer-with-anchor",
      personalEvidence,
      selectedPersonalEvidenceSources,
      unsupportedClaimRisk: "guarded",
    };
  }

  return {
    state: "no-anchor",
    requiredFor: "personal-logistics",
    supportedAnchorIds: [],
    supportedAnchorTitles: [],
    action: "ask-clarification",
    missingAnchorReason:
      "No relevant Interview Brief, profile-memory, or confirmed-Me fact supports this personal status/logistics answer.",
    personalEvidence,
    selectedPersonalEvidenceSources: [],
    unsupportedClaimRisk: "high",
  };
}

interface PersonalFactAnchor {
  id: string;
  title: string;
  source: PersonalEvidenceSource;
}

function collectInterviewBriefPersonalAnchors(
  brief: InterviewSessionBrief | undefined,
  questionText: string | undefined,
  statusDomain: PersonalEvidenceStatusDomain | undefined
): PersonalFactAnchor[] {
  if (!brief) return [];

  return [
    {
      id: "interview-brief:focus-areas",
      title: "Interview Brief focus areas",
      source: "interview-brief" as const,
      text: brief.focusAreas,
    },
    {
      id: "interview-brief:notes",
      title: "Interview Brief notes",
      source: "interview-brief" as const,
      text: brief.notes,
    },
  ]
    .filter((candidate) =>
      isRelevantPersonalEvidence(
        candidate.text,
        questionText,
        statusDomain
      )
    )
    .map(({ text: _text, ...anchor }) => anchor);
}

function collectProfileMemoryAnchors(
  entries: RetrievedMemoryEntry[],
  questionText: string | undefined,
  statusDomain: PersonalEvidenceStatusDomain | undefined
): PersonalFactAnchor[] {
  return entries
    .filter((item) => PERSONAL_PROFILE_ENTRY_TYPES.has(item.entry.type))
    .filter((item) =>
      isRelevantPersonalEvidence(
        [
          item.entry.title,
          item.entry.summary,
          item.entry.content,
          ...item.entry.tags,
          ...item.entry.keywords,
        ].join(" "),
        questionText,
        statusDomain
      )
    )
    .map((item) => ({
      id: item.entry.id,
      title: item.entry.title,
      source: "profile-memory" as const,
    }));
}

function collectConfirmedMeAnchors(
  facts: ConfirmedMeFact[],
  questionText: string | undefined,
  statusDomain: PersonalEvidenceStatusDomain | undefined
): PersonalFactAnchor[] {
  return facts
    .filter((fact) =>
      isRelevantPersonalEvidence(fact.text, questionText, statusDomain)
    )
    .map((fact) => ({
      id: `confirmed-me:${fact.id}`,
      title: "Confirmed Me context",
      source: "confirmed-me" as const,
    }));
}

function isRelevantPersonalEvidence(
  candidateText: string | undefined,
  questionText: string | undefined,
  statusDomain: PersonalEvidenceStatusDomain | undefined
) {
  const candidate = normalizeEvidenceText(candidateText);
  if (!candidate) return false;

  const questionTokens = tokenizeEvidenceText(questionText).filter(
    (token) =>
      token.length >= 5 &&
      !["about", "currently", "still", "expectations"].includes(token)
  );
  if (questionTokens.some((token) => candidate.includes(token))) {
    return true;
  }

  // Health claims need symptom- or status-specific support. A generic profile
  // mention such as health insurance must not support a medical-status answer.
  if (statusDomain === "health-status") return false;

  const domainTerms = statusDomain
    ? PERSONAL_STATUS_DOMAIN_TERMS[statusDomain]
    : [];
  if (
    domainTerms.some((term) =>
      candidate.includes(normalizeEvidenceText(term))
    )
  ) {
    return true;
  }
  return false;
}

function tokenizeEvidenceText(value: string | undefined) {
  return normalizeEvidenceText(value)
    .split(" ")
    .filter(Boolean);
}

function normalizeEvidenceText(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPersonalProfileMemoryContext(entries: RetrievedMemoryEntry[]) {
  if (!entries.length) {
    return "No profile-memory context was injected for this personal status/logistics question.";
  }

  return [
    '<memory_group runtime_role="personal-profile-fact" fact_support="true">',
    ...entries.map((item) => {
      const entry = item.entry;
      return [
        `<memory_entry id="${entry.id}" type="${entry.type}" source_family="profile-memory">`,
        `<title>${entry.title}</title>`,
        entry.summary ? `<summary>${entry.summary}</summary>` : undefined,
        `<content>${item.injectedContent}</content>`,
        "</memory_entry>",
      ]
        .filter(Boolean)
        .join("\n");
    }),
    "</memory_group>",
  ].join("\n\n");
}

function collectFactAnchorEntries(
  entries: RetrievedMemoryEntry[],
  projectBindingDecision?: ProjectBindingDecision
) {
  const eligible = entries.filter(
    (item) => resolveRetrievedMemoryRole(item).anchorEligible
  );
  const binding = projectBindingDecision?.binding;
  if (!binding) return eligible;

  const evidenceIds = new Set(binding.evidenceEntryIds);
  return eligible.filter(
    (item) =>
      evidenceIds.has(item.entry.id) ||
      projectIdentityMatchesBinding(
        item.entry.projectId,
        item.entry.projectName,
        binding.projectId,
        binding.projectName
      )
  );
}

function formatMemoryAnchorTitle(item: RetrievedMemoryEntry) {
  return getRuntimeFactAnchorLabel(item.entry);
}

function normalizeActiveFactAnchors(anchors: string[]) {
  return uniqueStrings(
    anchors
      .map((anchor) => anchor.trim())
      .filter(Boolean)
      .filter((anchor) => !GENERIC_ANCHOR_TITLES.has(anchor.toLowerCase()))
  ).slice(0, 8);
}

function activeAnchorMatchesBinding(
  anchor: string,
  binding: NonNullable<ProjectBindingDecision["binding"]>
) {
  return projectIdentityMatchesBinding(
    anchor,
    anchor,
    binding.projectId,
    binding.projectName
  );
}

function projectIdentityMatchesBinding(
  projectId: string | undefined,
  projectName: string | undefined,
  bindingProjectId: string | undefined,
  bindingProjectName: string
) {
  const itemIdentities = [projectId, projectName]
    .map(normalizeProjectIdentity)
    .filter(Boolean);
  const bindingIdentities = [bindingProjectId, bindingProjectName]
    .map(normalizeProjectIdentity)
    .filter(Boolean);
  return itemIdentities.some((itemIdentity) =>
    bindingIdentities.some(
      (bindingIdentity) =>
        itemIdentity === bindingIdentity ||
        (itemIdentity.length >= 4 && bindingIdentity.includes(itemIdentity)) ||
        (bindingIdentity.length >= 4 && itemIdentity.includes(bindingIdentity))
    )
  );
}

function normalizeProjectIdentity(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(project|system|feature)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[]));
}
