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
  AdvisorPreparedFactEvidence,
  ClaimPredicateFamily,
  ClaimSupportDecision,
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
  confirmedMeFacts?: ConfirmedMeFact[];
  activeFactAnchors?: string[];
  projectAnchor?: string;
  personalEvidenceDecision?: PersonalEvidenceDecision;
  projectBindingDecision?: ProjectBindingDecision;
  preparationFactEvidence?: AdvisorPreparedFactEvidence[];
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
  confirmedMeFacts = [],
  activeFactAnchors = [],
  projectAnchor,
  personalEvidenceDecision,
  projectBindingDecision,
  preparationFactEvidence = [],
}: BuildFactAnchorDecisionInput): FactAnchorDecision {
  const personalEvidence =
    personalEvidenceDecision ??
    detectPersonalEvidenceRequirement({
      questionText,
      questionType,
      mode: personalEvidenceGuardrailMode,
    });
  const requirementResolution = resolveFactAnchorRequirement(
    questionType,
    personalEvidence
  );
  const requiredFor = requirementResolution.requiredFor;
  if (requiredFor === "none") {
    return {
      state: "not-required",
      requiredFor,
      supportedAnchorIds: [],
      supportedAnchorTitles: [],
      action: "answer-with-anchor",
      personalEvidence,
      selectedPersonalEvidenceSources: [],
      claimSupportDecisions: [],
      requirementSource: requirementResolution.source,
      requirementReason: requirementResolution.reason,
      unsupportedClaimRisk:
        personalEvidence.mode === "shadow" &&
        personalEvidence.confidenceTier === "high" &&
        personalEvidence.requirement !== "not-required"
          ? "shadow-observed"
          : "none",
    };
  }

  if (requiredFor === "personal-logistics") {
    return {
      ...buildPersonalStatusFactDecision({
        questionText,
        personalEvidence,
        memoryContext,
        confirmedMeFacts,
      }),
      requirementSource: requirementResolution.source,
      requirementReason: requirementResolution.reason,
    };
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
      claimPredicateFamily: "project-overview",
      claimSupportDecisions: [],
      requirementSource: requirementResolution.source,
      requirementReason: requirementResolution.reason,
      unsupportedClaimRisk: "high",
    };
  }

  const predicateFamily = inferClaimPredicateFamily(
    questionText,
    requiredFor
  );
  const claimSupportDecisions = evaluateClaimSupport({
    entries: memoryContext?.entries ?? [],
    activeFactAnchors,
    projectBindingDecision,
    predicateFamily,
  });
  const preparationClaimSupportDecisions =
    evaluatePreparationClaimSupport({
      evidence: preparationFactEvidence,
      predicateFamily,
    });
  claimSupportDecisions.push(...preparationClaimSupportDecisions);
  const allowedAnchorIds = new Set(
    claimSupportDecisions
      .filter((decision) => decision.decision === "allow")
      .map((decision) => decision.anchorId)
      .filter((value): value is string => Boolean(value))
  );
  const memoryAnchors = collectFactAnchorEntries(
    memoryContext?.entries ?? [],
    projectBindingDecision
  ).filter((item) => allowedAnchorIds.has(item.entry.id));
  const preparationAnchors = preparationFactEvidence.filter((item) =>
    allowedAnchorIds.has(item.statementId)
  );
  const supportedAnchorIds = uniqueStrings([
    ...memoryAnchors.map((item) => item.entry.id),
    ...preparationAnchors.map((item) => item.statementId),
  ]);
  const supportedAnchorTitles = uniqueStrings([
    ...memoryAnchors.map(formatMemoryAnchorTitle),
    ...preparationAnchors.map(
      (item) => item.allowedWording ?? item.content.slice(0, 160)
    ),
  ]);

  if (memoryAnchors.length || preparationAnchors.length) {
    return {
      state: "strong-anchor",
      requiredFor,
      supportedAnchorIds,
      supportedAnchorTitles,
      selectedAnchorId:
        memoryAnchors[0]?.entry.id ??
        preparationAnchors[0]?.statementId,
      action: "answer-with-anchor",
      personalEvidence,
      selectedPersonalEvidenceSources: [],
      claimPredicateFamily: predicateFamily,
      claimSupportDecisions,
      requirementSource: requirementResolution.source,
      requirementReason: requirementResolution.reason,
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
      claimPredicateFamily: predicateFamily,
      claimSupportDecisions,
      requirementSource: requirementResolution.source,
      requirementReason: requirementResolution.reason,
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
    claimPredicateFamily: predicateFamily,
    claimSupportDecisions,
    requirementSource: requirementResolution.source,
    requirementReason: requirementResolution.reason,
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
    decision.requirementSource
      ? `Requirement source: ${decision.requirementSource}`
      : undefined,
    decision.requirementReason
      ? `Requirement reason: ${decision.requirementReason}`
      : undefined,
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
    decision.claimPredicateFamily
      ? `Claim predicate family: ${decision.claimPredicateFamily}`
      : undefined,
    decision.claimSupportDecisions.length
      ? `Allowed claim anchors: ${decision.claimSupportDecisions
          .filter((item) => item.decision === "allow")
          .map((item) => item.anchorId)
          .filter(Boolean)
          .join(", ") || "none"}`
      : undefined,
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
      ? "Personal status/logistics rule: use only the listed profile-memory or confirmed-Me anchors. Manual company/type defaults are not fact evidence. Never borrow project/story facts or infer recovery/status. If the needed fact is absent, ask for it or stay explicitly fact-neutral."
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
    factAnchorRequirementSource: decision.requirementSource,
    factAnchorRequirementReason: decision.requirementReason,
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
    factAnchorClaimPredicateFamily: decision.claimPredicateFamily,
    factAnchorClaimSupportDecisions: decision.claimSupportDecisions,
  };
}

function resolveFactAnchorRequirement(
  questionType: MemoryQuestionType | undefined,
  personalEvidence: FactAnchorDecision["personalEvidence"]
): {
  requiredFor: FactAnchorRequiredFor;
  source: NonNullable<FactAnchorDecision["requirementSource"]>;
  reason: string;
} {
  if (personalEvidence.enforced) {
    if (personalEvidence.requirement === "personal-logistics") {
      return {
        requiredFor: "personal-logistics",
        source: "current-question-personal-evidence",
        reason: "current-question-requires-personal-logistics-evidence",
      };
    }
    return {
      requiredFor:
        personalEvidence.requirement === "autobiographical-behavioral"
          ? "behavioral"
          : "project-deep-dive",
      source: "current-question-personal-evidence",
      reason: "current-question-requires-autobiographical-evidence",
    };
  }
  if (
    personalEvidence.requirement === "not-required" &&
    personalEvidence.confidenceTier === "high" &&
    personalEvidence.counterSignals.length > 0
  ) {
    return {
      requiredFor: "none",
      source: "current-question-personal-evidence",
      reason: "explicit-hypothetical-current-question-overrides-parent-type",
    };
  }
  if (questionType === "behavioral") {
    return {
      requiredFor: "behavioral",
      source: "settled-question-type",
      reason: "settled-behavioral-question-type",
    };
  }
  if (questionType === "project-deep-dive") {
    return {
      requiredFor: "project-deep-dive",
      source: "settled-question-type",
      reason: "settled-project-deep-dive-question-type",
    };
  }
  return {
    requiredFor: "none",
    source: "none",
    reason: "current-question-does-not-require-personal-fact-evidence",
  };
}

function buildPersonalStatusFactDecision({
  questionText,
  personalEvidence,
  memoryContext,
  confirmedMeFacts,
}: {
  questionText?: string;
  personalEvidence: PersonalEvidenceDecision;
  memoryContext?: MemoryRetrievalResult | null;
  confirmedMeFacts: ConfirmedMeFact[];
}): FactAnchorDecision {
  const anchors = [
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
      claimPredicateFamily: "personal-status",
      claimSupportDecisions: [],
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
      "No relevant profile-memory or confirmed-Me fact supports this personal status/logistics answer. Manual company/type defaults are not fact evidence.",
    personalEvidence,
    selectedPersonalEvidenceSources: [],
    claimPredicateFamily: "personal-status",
    claimSupportDecisions: [],
    unsupportedClaimRisk: "high",
  };
}

interface PersonalFactAnchor {
  id: string;
  title: string;
  source: PersonalEvidenceSource;
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

function inferClaimPredicateFamily(
  questionText: string | undefined,
  requiredFor: FactAnchorRequiredFor
): ClaimPredicateFamily {
  if (requiredFor === "behavioral") return "behavioral-story";
  if (requiredFor === "personal-logistics") return "personal-status";

  const normalized = normalizeEvidenceText(questionText);
  if (
    hasAnyEvidenceTerm(normalized, [
      "stakeholder",
      "partner",
      "who did you work with",
      "collaborate",
      "cross functional",
    ])
  ) {
    return "collaboration-stakeholders";
  }
  if (
    hasAnyEvidenceTerm(normalized, [
      "your role",
      "your contribution",
      "personally",
      "what did you do",
      "what were you responsible",
      "ownership",
    ])
  ) {
    return "role-contribution";
  }
  if (
    hasAnyEvidenceTerm(normalized, [
      "failure",
      "failed",
      "challenge",
      "difficult",
      "debug",
      "test",
      "validate",
      "reliability",
      "recover",
      "incident",
      "wrong",
    ])
  ) {
    return "validation-reliability";
  }
  if (
    hasAnyEvidenceTerm(normalized, [
      "impact",
      "result",
      "metric",
      "outcome",
      "lesson",
      "learn",
      "improve",
      "next time",
      "limitation",
    ])
  ) {
    return "impact-lessons";
  }
  if (
    hasAnyEvidenceTerm(normalized, [
      "architecture",
      "design",
      "decision",
      "tradeoff",
      "trade off",
      "alternative",
      "why did you choose",
      "approach",
      "option",
      "backend system",
      "database",
      "data store",
      "cache",
    ])
  ) {
    return "architecture-decision";
  }
  return "project-overview";
}

function evaluateClaimSupport({
  entries,
  activeFactAnchors,
  projectBindingDecision,
  predicateFamily,
}: {
  entries: RetrievedMemoryEntry[];
  activeFactAnchors: string[];
  projectBindingDecision?: ProjectBindingDecision;
  predicateFamily: ClaimPredicateFamily;
}): ClaimSupportDecision[] {
  const eligibleEntries = collectFactAnchorEntries(
    entries,
    projectBindingDecision
  );
  const decisions = eligibleEntries.map((item) =>
    evaluateMemoryClaimSupport({
      item,
      binding: projectBindingDecision?.binding,
      predicateFamily,
    })
  );
  const evaluatedIds = new Set(
    decisions
      .map((decision) => decision.anchorId)
      .filter((value): value is string => Boolean(value))
  );

  for (const activeAnchor of normalizeActiveFactAnchors(
    activeFactAnchors
  )) {
    if (evaluatedIds.has(activeAnchor)) continue;
    decisions.push({
      claimId: `claim:${predicateFamily}:${activeAnchor}`,
      predicateFamily,
      anchorId: activeAnchor,
      projectCompatible: false,
      predicateCompatible: false,
      supportSpanPresent: false,
      conflictFree: false,
      decision: "reject",
      reason:
        "active-anchor-is-not-present-in-settled-fact-evidence",
    });
  }

  return decisions;
}

function evaluatePreparationClaimSupport({
  evidence,
  predicateFamily,
}: {
  evidence: AdvisorPreparedFactEvidence[];
  predicateFamily: ClaimPredicateFamily;
}): ClaimSupportDecision[] {
  return evidence.map((item) => {
    const firstPersonCompatible =
      item.ownership === "candidate-owned" ||
      item.ownership === "team-owned";
    const evidenceText = normalizeEvidenceText(
      [item.content, item.allowedWording].filter(Boolean).join(" ")
    );
    const predicateTerms = CLAIM_PREDICATE_TERMS[predicateFamily];
    const predicateCompatible =
      predicateFamily === "project-overview" ||
      predicateFamily === "behavioral-story" ||
      hasAnyEvidenceTerm(evidenceText, predicateTerms);
    const supportSpan = extractSupportSpan(
      item.allowedWording ?? item.content,
      predicateFamily === "project-overview" ||
        predicateFamily === "behavioral-story"
        ? []
        : predicateTerms
    );
    const supportSpanPresent = Boolean(supportSpan);
    const allowed =
      firstPersonCompatible &&
      predicateCompatible &&
      supportSpanPresent;
    return {
      claimId: `claim:${predicateFamily}:preparation:${item.statementId}`,
      predicateFamily,
      anchorId: item.statementId,
      projectCompatible: true,
      predicateCompatible,
      supportSpanPresent,
      supportSpan,
      conflictFree: firstPersonCompatible,
      decision: allowed ? "allow" : "reject",
      reason: allowed
        ? "reviewed-preparation-evidence-supports-current-predicate"
        : !firstPersonCompatible
          ? "preparation-evidence-ownership-is-not-first-person-compatible"
          : !predicateCompatible
            ? "preparation-evidence-does-not-support-current-claim-family"
            : "preparation-evidence-has-no-bounded-support-span",
    };
  });
}

function evaluateMemoryClaimSupport({
  item,
  binding,
  predicateFamily,
}: {
  item: RetrievedMemoryEntry;
  binding?: NonNullable<ProjectBindingDecision["binding"]>;
  predicateFamily: ClaimPredicateFamily;
}): ClaimSupportDecision {
  const entry = item.entry;
  const projectCompatible = binding
    ? projectIdentityMatchesBinding(
        entry.projectId,
        entry.projectName,
        binding.projectId,
        binding.projectName
      )
    : true;
  const evidenceText = [
    entry.title,
    entry.summary,
    item.injectedContent,
    ...entry.tags,
    ...entry.keywords,
  ]
    .filter(Boolean)
    .join(" ");
  const normalizedEvidence = normalizeEvidenceText(evidenceText);
  const predicateTerms = CLAIM_PREDICATE_TERMS[predicateFamily];
  const predicateCompatible =
    predicateFamily === "project-overview"
      ? normalizedEvidence.length >= 16
      : predicateFamily === "behavioral-story"
        ? [
            "personal_story",
            "answer_evidence",
            "achievement_metric",
            "project_context",
          ].includes(entry.type)
        : hasAnyEvidenceTerm(normalizedEvidence, predicateTerms);
  const supportSpan = extractSupportSpan(
    item.injectedContent || entry.summary || entry.content,
    predicateFamily === "project-overview" ||
      predicateFamily === "behavioral-story"
      ? []
      : predicateTerms
  );
  const supportSpanPresent = Boolean(supportSpan);
  const conflictFree = projectCompatible;
  const allowed =
    projectCompatible &&
    predicateCompatible &&
    supportSpanPresent &&
    conflictFree;

  return {
    claimId: `claim:${predicateFamily}:${entry.id}`,
    predicateFamily,
    anchorId: entry.id,
    projectCompatible,
    predicateCompatible,
    supportSpanPresent,
    supportSpan,
    conflictFree,
    decision: allowed ? "allow" : "reject",
    reason: allowed
      ? "anchor-supports-current-project-predicate"
      : !projectCompatible
        ? "anchor-project-does-not-match-settled-binding"
        : !predicateCompatible
          ? "anchor-predicate-does-not-support-current-claim-family"
          : "anchor-has-no-bounded-support-span",
  };
}

function extractSupportSpan(text: string | undefined, terms: string[]) {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (compact.length < 12) return undefined;
  if (!terms.length) return compact.slice(0, 260);

  const sentences = compact
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const supportingSentence = sentences.find((sentence) =>
    hasAnyEvidenceTerm(normalizeEvidenceText(sentence), terms)
  );
  return supportingSentence?.slice(0, 260);
}

function hasAnyEvidenceTerm(text: string, terms: string[]) {
  return terms.some((term) =>
    text.includes(normalizeEvidenceText(term))
  );
}

const CLAIM_PREDICATE_TERMS: Record<ClaimPredicateFamily, string[]> = {
  "project-overview": [],
  "architecture-decision": [
    "architecture",
    "design",
    "component",
    "pipeline",
    "strategy",
    "decision",
    "tradeoff",
    "trade off",
    "alternative",
    "option",
    "chose",
    "choice",
  ],
  "validation-reliability": [
    "failure",
    "failed",
    "error",
    "debug",
    "test",
    "validation",
    "reliability",
    "recover",
    "recovery",
    "incident",
    "root cause",
    "json",
    "parser",
  ],
  "impact-lessons": [
    "impact",
    "result",
    "metric",
    "latency",
    "throughput",
    "cost",
    "saved",
    "reduced",
    "improved",
    "lesson",
    "learned",
    "limitation",
    "next",
  ],
  "role-contribution": [
    "implemented",
    "designed",
    "built",
    "led",
    "drove",
    "owned",
    "investigated",
    "contributed",
    "my role",
    "responsible",
  ],
  "collaboration-stakeholders": [
    "partner",
    "stakeholder",
    "collaborated",
    "collaboration",
    "cross functional",
    "team",
  ],
  "behavioral-story": [],
  "personal-status": [],
};

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
