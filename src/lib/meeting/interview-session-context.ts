import type {
  InterviewCompanyCandidateDisposition,
  InterviewCompanyHistoryEntry,
  InterviewCompanyMentionRole,
  InterviewSessionBrief,
  InterviewSessionContext,
  InterviewSessionContextSource,
  InterviewTargetCompany,
  TranscriptSpeaker,
  TranscriptTurn,
} from "./types";

interface CompanyDefinition {
  displayName: string;
  normalized: string;
  aliases: string[];
}

const COMPANY_DEFINITIONS: CompanyDefinition[] = [
  {
    displayName: "Amazon",
    normalized: "amazon",
    aliases: ["amazon", "amazon web services", "aws"],
  },
  {
    displayName: "Microsoft",
    normalized: "microsoft",
    aliases: ["microsoft"],
  },
  {
    displayName: "Google",
    normalized: "google",
    aliases: ["google"],
  },
  {
    displayName: "Meta",
    normalized: "meta",
    aliases: ["meta", "facebook"],
  },
  {
    displayName: "NVIDIA",
    normalized: "nvidia",
    aliases: ["nvidia"],
  },
  {
    displayName: "Apple",
    normalized: "apple",
    aliases: ["apple"],
  },
  {
    displayName: "Netflix",
    normalized: "netflix",
    aliases: ["netflix"],
  },
  {
    displayName: "ByteDance",
    normalized: "bytedance",
    aliases: ["bytedance", "byte dance", "tiktok"],
  },
  {
    displayName: "Airbnb",
    normalized: "airbnb",
    aliases: ["airbnb"],
  },
  {
    displayName: "OpenAI",
    normalized: "openai",
    aliases: ["openai", "open ai"],
  },
  {
    displayName: "Anthropic",
    normalized: "anthropic",
    aliases: ["anthropic"],
  },
  {
    displayName: "Databricks",
    normalized: "databricks",
    aliases: ["databricks"],
  },
  {
    displayName: "Stripe",
    normalized: "stripe",
    aliases: ["stripe"],
  },
  {
    displayName: "Tesla",
    normalized: "tesla",
    aliases: ["tesla"],
  },
  {
    displayName: "xAI",
    normalized: "xai",
    aliases: ["xai", "x ai"],
  },
];

export const INTERVIEW_COMPANY_OPTIONS = COMPANY_DEFINITIONS.map(
  (company) => ({
    value: company.displayName,
    normalized: company.normalized,
  })
);

const TARGET_COMPANY_LOCK_CONFIDENCE = 0.9;
const MAX_COMPANY_HISTORY_ENTRIES = 24;

export interface InterviewCompanyDetectionDecision {
  candidate?: InterviewTargetCompany;
  mentionRole: InterviewCompanyMentionRole;
  disposition: InterviewCompanyCandidateDisposition;
  source: InterviewSessionContextSource;
  speaker?: TranscriptSpeaker;
  mentionedCompanies: string[];
  reason: string;
}

export interface InterviewSessionUpdate {
  context: InterviewSessionContext;
  changed: boolean;
  targetCompany?: InterviewTargetCompany;
  companyDecision?: InterviewCompanyDetectionDecision;
}

export interface AmazonLeadershipPrincipleHint {
  id: string;
  label: string;
  reason: string;
}

const AMAZON_LP_HINTS: Array<
  AmazonLeadershipPrincipleHint & { markers: string[] }
> = [
  {
    id: "customer-obsession",
    label: "Customer Obsession",
    reason: "customer impact, user trust, customer feedback, or working backwards",
    markers: [
      "customer obsession",
      "working backwards",
      "customer need",
      "customer feedback",
      "customer came to you",
      "customer experience",
      "customer trust",
      "customer request",
      "unreasonable requests",
      "balance the needs of the customer",
      "meet the needs of your customers",
      "above and beyond for a customer",
      "anticipate a customer need",
      "customer",
      "customers",
      "user",
      "users",
      "client",
    ],
  },
  {
    id: "ownership",
    label: "Ownership",
    reason: "long-term ownership, responsibility beyond scope, or never saying not my job",
    markers: [
      "ownership",
      "didn't think you were going to meet a commitment you promised",
      "did not think you were going to meet a commitment you promised",
      "meet a commitment you promised",
      "commitment you promised",
      "outside your area of responsibility",
      "whole company",
      "wasn't within any group's individual responsibility",
      "not my job",
      "long term value",
      "sacrifice short term gain",
      "transition a project you owned",
      "step in and help",
      "took responsibility",
      "beyond",
      "follow through",
      "accountable",
    ],
  },
  {
    id: "invent-and-simplify",
    label: "Invent and Simplify",
    reason: "innovation, simplification, automation, or new mechanism design",
    markers: [
      "invent and simplify",
      "complex problem you solved with a simple solution",
      "most innovative thing",
      "make something simpler",
      "new thinking and innovation",
      "usual approach wouldn't address",
      "alternative approach",
      "novel idea",
      "novel approach",
      "significant change or improvement",
      "invent",
      "simplify",
      "automate",
      "automation",
      "manual",
      "repetitive",
      "complexity",
    ],
  },
  {
    id: "are-right-a-lot",
    label: "Are Right, A Lot",
    reason: "judgment quality, disconfirming beliefs, ambiguous data, or diverse perspectives",
    markers: [
      "are right a lot",
      "didn't have enough data to make the right decision",
      "without clear data or benchmarks",
      "input from many different sources",
      "made a bad decision",
      "made an error in judgment",
      "idea was not the best course of action",
      "brought different perspectives together",
      "disconfirm their beliefs",
      "not enough data",
      "unclear data",
      "ambiguous",
      "benchmarks",
      "right decision",
      "final decision",
      "alternatives",
      "tradeoffs",
      "trade-offs",
      "mitigate risk",
      "judgment",
    ],
  },
  {
    id: "learn-and-be-curious",
    label: "Learn and Be Curious",
    reason: "learning, curiosity, new domains, feedback, or self-improvement",
    markers: [
      "learn and be curious",
      "deeper level of subject matter expertise",
      "outside of your comfort area",
      "didn't know what to do next",
      "how do you learn what you don't know",
      "improve your overall work effectiveness",
      "explored a new or unexpected area",
      "challenged you to think differently",
      "external trends",
      "learn",
      "curious",
      "curiosity",
      "feedback",
      "self improvement",
      "new skill",
      "new domain",
    ],
  },
  {
    id: "hire-and-develop-the-best",
    label: "Hire and Develop the Best",
    reason: "developing others, raising talent bar, coaching, feedback, or performance growth",
    markers: [
      "hire and develop the best",
      "develop the strengths of someone",
      "positively impact their performance",
      "mentor",
      "mentored",
      "coach",
      "coached",
      "develop someone",
      "developing others",
      "raise the bar",
      "performance improvement",
      "team member grew",
      "hiring",
      "talent",
    ],
  },
  {
    id: "insist-on-the-highest-standards",
    label: "Insist on the Highest Standards",
    reason: "quality bar, standards, continuous improvement, or standards versus delivery",
    markers: [
      "insist on the highest standards",
      "quality of a product",
      "getting good customer feedback",
      "standards and delivery",
      "wish you had done better",
      "continuous improvement project",
      "feedback about your team",
      "highest standards",
      "quality bar",
      "high standards",
      "raise standards",
      "standards",
      "quality",
    ],
  },
  {
    id: "think-big",
    label: "Think Big",
    reason: "bold vision, bigger opportunity, novel direction, or global adoption",
    markers: [
      "think big",
      "opportunity to do something much bigger",
      "changed the direction or view",
      "new way of thinking",
      "proposed a novel approach",
      "drove adoption for your vision",
      "idea or vision",
      "global stakeholders",
      "thought differently",
      "established a vision",
      "big risk",
      "bold direction",
      "bigger or better",
      "vision",
    ],
  },
  {
    id: "frugality",
    label: "Frugality",
    reason: "cost, waste, resource limits, or doing more with less",
    markers: [
      "cost",
      "costs",
      "save",
      "saved",
      "waste",
      "eliminate waste",
      "resource",
      "resources",
      "budget",
      "frugal",
      "efficient",
      "efficiency",
    ],
  },
  {
    id: "bias-for-action",
    label: "Bias for Action",
    reason: "speed, reversibility, or acting under uncertainty",
    markers: [
      "bias for action",
      "moving forward or gathering more information",
      "moving forward",
      "gathering more information",
      "gather more information",
      "worked against tight deadlines",
      "didn't have time to consider all options",
      "without consulting your manager",
      "respond immediately",
      "took a proactive approach",
      "not moving to action quickly enough",
      "remove a serious roadblock",
      "calculated risk",
      "speed was critical",
      "quickly",
      "fast",
      "urgent",
      "reversible",
      "limited time",
      "time pressure",
      "deadline",
    ],
  },
  {
    id: "dive-deep",
    label: "Dive Deep",
    reason: "root cause, details, metrics, or investigation depth",
    markers: [
      "dive deep",
      "dig into the details",
      "dig deep",
      "root cause",
      "in-depth thought and analysis",
      "big problem or issue",
      "specific metric",
      "created a metric",
      "validate the assumptions",
      "root cause",
      "investigate",
      "debug",
      "details",
      "metrics",
      "data analysis",
      "deep dive",
    ],
  },
  {
    id: "earn-trust",
    label: "Earn Trust",
    reason: "communication, disagreement, credibility, or relationship repair",
    markers: [
      "earn trust",
      "not able to meet a commitment",
      "were not able to meet a commitment",
      "what was the commitment",
      "communicate a change in direction",
      "tough or critical piece of feedback",
      "influence a peer",
      "differing opinion",
      "goals were out of alignment",
      "uncovered a significant problem",
      "improved morale",
      "team member was struggling",
      "team member was not performing well",
      "trust",
      "stakeholder",
      "stakeholders",
      "conflict",
      "disagreement",
      "relationship",
      "communication",
      "feedback",
    ],
  },
  {
    id: "deliver-results",
    label: "Deliver Results",
    reason: "hard commitments, blockers, or measurable delivery",
    markers: [
      "deliver results",
      "deliver an important project under a tight deadline",
      "unanticipated obstacles",
      "key goal",
      "exceeded expectations",
      "more than half way to meeting a goal",
      "mission or goal you didn't think was achievable",
      "did not effectively manage your projects",
      "set goals",
      "deliver",
      "results",
      "deadline",
      "blocked",
      "blocker",
      "goal",
      "commitment",
      "impact",
    ],
  },
  {
    id: "have-backbone",
    label: "Have Backbone; Disagree and Commit",
    reason: "challenging a decision, disagreeing, and committing afterward",
    markers: [
      "have backbone",
      "disagree and commit",
      "committed to a group decision even though you disagreed",
      "submitted a great idea to your manager and they did not support it",
      "pushed back",
      "disagree",
      "commit",
      "push back",
      "challenged",
      "backbone",
      "conflict",
      "different opinion",
    ],
  },
  {
    id: "strive-to-be-earths-best-employer",
    label: "Strive to Be Earth's Best Employer",
    reason: "inclusive environment, employee growth, empathy, safety, or team well-being",
    markers: [
      "strive to be earth's best employer",
      "more inclusive working environment",
      "advocated for someone",
      "improving the work experience",
      "diversity",
      "equity",
      "inclusion",
      "compassion",
      "supported or empowered someone",
      "foster an enjoyable work environment",
      "being excluded or treated unfairly",
      "comfortable speaking up",
      "improve your team's work environment",
      "team well-being",
      "safe work environment",
    ],
  },
  {
    id: "success-and-scale",
    label: "Success and Scale Bring Broad Responsibility",
    reason: "downstream impact, social responsibility, unintended consequences, or broad responsibility at scale",
    markers: [
      "success and scale bring broad responsibility",
      "impact beyond your immediate client",
      "downstream impact",
      "unintended consequences",
      "negative impact",
      "third-party",
      "social responsibility",
      "everyone who was affected",
      "environmental or societal impacts",
      "left something better than how you found it",
      "organizational change to bring new social awareness",
      "broad responsibility",
      "secondary effects",
    ],
  },
];

export function updateInterviewSessionContextFromTurn(
  currentContext: InterviewSessionContext | undefined,
  turn: TranscriptTurn,
  now = Date.now()
): InterviewSessionUpdate {
  const companyDecision = detectInterviewCompanyDecision({
    text: turn.text,
    now,
    source: "transcript",
    speaker: turn.speaker,
  });
  return updateInterviewSessionContextWithCompanyDecision(
    currentContext,
    companyDecision
  );
}

export function updateInterviewSessionContextFromScreenText(
  currentContext: InterviewSessionContext | undefined,
  text: string,
  evidence = text,
  now = Date.now()
): InterviewSessionUpdate {
  const companyDecision = detectInterviewCompanyDecision({
    text,
    now,
    source: "screen",
    evidence,
  });
  return updateInterviewSessionContextWithCompanyDecision(
    currentContext,
    companyDecision
  );
}

export function createInterviewSessionContextFromBrief(
  brief: InterviewSessionBrief | undefined,
  now = Date.now()
): InterviewSessionContext | undefined {
  const detectedCompany = createInterviewTargetCompanyFromBrief(brief, now);
  return detectedCompany ? { targetCompany: detectedCompany } : undefined;
}

export function updateInterviewSessionContextFromBrief(
  currentContext: InterviewSessionContext | undefined,
  brief: InterviewSessionBrief | undefined,
  now = Date.now()
): InterviewSessionUpdate {
  const detectedCompany = createInterviewTargetCompanyFromBrief(brief, now);

  if (!detectedCompany) {
    const context = currentContext ? { ...currentContext } : {};
    const changed = context.targetCompany?.source === "brief";
    if (changed) {
      delete context.targetCompany;
    }
    return { context, changed };
  }

  const context = currentContext ? { ...currentContext } : {};
  const previous = context.targetCompany;
  context.targetCompany = detectedCompany;

  const changed = !previous ||
    previous.normalized !== detectedCompany.normalized ||
    previous.source !== detectedCompany.source ||
    previous.confidence !== detectedCompany.confidence;

  return {
    context,
    changed,
    targetCompany: detectedCompany,
  };
}

export function normalizeInterviewBriefCompany(
  companyName: string | undefined
) {
  const trimmed = companyName?.trim();
  if (!trimmed) return undefined;

  const detectedCompany = detectInterviewCompany(
    `${trimmed} interview`,
    Date.now(),
    "brief",
    trimmed
  );

  if (detectedCompany) {
    return {
      value: detectedCompany.value,
      normalized: detectedCompany.normalized,
    };
  }

  const normalized = normalizeForMatching(trimmed).replace(/\s+/g, "-");
  return normalized
    ? {
        value: trimmed,
        normalized,
      }
    : undefined;
}

export function normalizeInterviewBriefCompanyLock(
  companyName: string | undefined,
  requestedLock: boolean | undefined
) {
  return Boolean(normalizeInterviewBriefCompany(companyName) && requestedLock);
}

function createInterviewTargetCompanyFromBrief(
  brief: InterviewSessionBrief | undefined,
  now = Date.now()
): InterviewTargetCompany | undefined {
  const company = normalizeInterviewBriefCompany(brief?.targetCompany);
  if (!company) return undefined;

  return {
    value: company.value,
    normalized: company.normalized,
    confidence: brief?.companyLocked === false ? 0.82 : 1,
    source: "brief",
    evidence: "Interview Session Brief",
    updatedAt: brief?.updatedAt ?? now,
  };
}

function updateInterviewSessionContextWithCompanyDecision(
  currentContext: InterviewSessionContext | undefined,
  companyDecision: InterviewCompanyDetectionDecision
): InterviewSessionUpdate {
  const context = currentContext ? { ...currentContext } : {};

  if (
    companyDecision.disposition !== "candidate-proposed" ||
    !companyDecision.candidate
  ) {
    return {
      context: appendCompanyHistory(context, companyDecision),
      changed: false,
      companyDecision,
    };
  }

  const previous = context.targetCompany;
  const replacement = decideTargetCompanyReplacement(
    previous,
    companyDecision.candidate
  );

  if (!replacement.replace) {
    const rejectedDecision: InterviewCompanyDetectionDecision = {
      ...companyDecision,
      disposition: replacement.disposition,
      reason: replacement.reason,
    };
    return {
      context: appendCompanyHistory(context, rejectedDecision),
      changed: false,
      companyDecision: rejectedDecision,
    };
  }

  const committedDecision: InterviewCompanyDetectionDecision = {
    ...companyDecision,
    disposition: "candidate-committed",
    reason: replacement.reason,
  };
  context.targetCompany = companyDecision.candidate;
  return {
    context: appendCompanyHistory(context, committedDecision),
    changed: true,
    targetCompany: companyDecision.candidate,
    companyDecision: committedDecision,
  };
}

function decideTargetCompanyReplacement(
  previous: InterviewTargetCompany | undefined,
  detectedCompany: InterviewTargetCompany
): {
  replace: boolean;
  disposition:
    | "candidate-committed"
    | "candidate-rejected-lock"
    | "candidate-rejected-confidence";
  reason: string;
} {
  if (!previous) {
    return {
      replace: true,
      disposition: "candidate-committed",
      reason: "no-confirmed-target-company",
    };
  }

  const previousAuthority = companySourceAuthority(previous.source);
  const detectedAuthority = companySourceAuthority(detectedCompany.source);
  const sameCompany =
    detectedCompany.normalized === previous.normalized;
  const lockedByUser =
    (previous.source === "brief" || previous.source === "manual") &&
    previous.confidence >= TARGET_COMPANY_LOCK_CONFIDENCE;

  if (lockedByUser && detectedAuthority < previousAuthority) {
    return {
      replace: false,
      disposition: "candidate-rejected-lock",
      reason: sameCompany
        ? "same-company-lower-authority-cannot-downgrade-lock"
        : "different-company-cannot-overwrite-user-lock",
    };
  }

  if (sameCompany) {
    if (
      detectedAuthority < previousAuthority ||
      detectedCompany.confidence <= previous.confidence
    ) {
      return {
        replace: false,
        disposition: "candidate-rejected-confidence",
        reason: "same-company-update-would-lower-authority-or-confidence",
      };
    }
    return {
      replace: true,
      disposition: "candidate-committed",
      reason: "same-company-higher-authority-or-confidence",
    };
  }

  if (
    previous.confidence >= TARGET_COMPANY_LOCK_CONFIDENCE &&
    detectedAuthority <= previousAuthority
  ) {
    return {
      replace: false,
      disposition: "candidate-rejected-lock",
      reason: "confirmed-company-requires-higher-authority-replacement",
    };
  }

  if (
    detectedCompany.confidence >= 0.95 &&
    detectedCompany.confidence > previous.confidence + 0.05
  ) {
    return {
      replace: true,
      disposition: "candidate-committed",
      reason: "higher-confidence-explicit-target-replacement",
    };
  }

  return {
    replace: false,
    disposition: "candidate-rejected-confidence",
    reason: "replacement-threshold-not-met",
  };
}

export function detectInterviewCompany(
  text: string,
  now = Date.now(),
  source: InterviewSessionContextSource = "transcript",
  evidence = text
): InterviewTargetCompany | undefined {
  return detectInterviewCompanyDecision({
    text,
    now,
    source,
    evidence,
    speaker: source === "transcript" ? "them" : undefined,
  }).candidate;
}

export function detectInterviewCompanyDecision({
  text,
  now = Date.now(),
  source = "transcript",
  evidence = text,
  speaker,
}: {
  text: string;
  now?: number;
  source?: InterviewSessionContextSource;
  evidence?: string;
  speaker?: TranscriptSpeaker;
}): InterviewCompanyDetectionDecision {
  const normalizedText = normalizeForMatching(text);
  if (!normalizedText) {
    return noCompanyCandidateDecision(source, speaker);
  }

  const mentionedCompanies = findKnownCompanyMentions(normalizedText);
  const explicitTargets = findExplicitTargetCompanies(text, normalizedText);
  const uniqueTargets = uniqueCompanies(explicitTargets);

  if (uniqueTargets.length > 1) {
    return {
      mentionRole: "unknown",
      disposition: "candidate-conflict",
      source,
      speaker,
      mentionedCompanies: uniqueTargets.map(
        (company) => company.displayName
      ),
      reason: "multiple-explicit-target-companies",
    };
  }

  if (uniqueTargets.length === 1) {
    return authorizeCompanyMentionForSpeaker({
      company: uniqueTargets[0],
      confidence: 0.97,
      mentionRole: "interview-target",
      source,
      speaker,
      evidence,
      now,
      mentionedCompanies,
      reason: "explicit-interview-target-phrase",
    });
  }

  if (isCompanyComparison(normalizedText, mentionedCompanies)) {
    return rejectedCompanyRoleDecision({
      company: mentionedCompanies[0],
      mentionRole: "comparison-only",
      source,
      speaker,
      mentionedCompanies,
      reason: "company-mentioned-only-as-comparison",
    });
  }

  const historyCompany = findCandidateHistoryCompany(
    normalizedText,
    mentionedCompanies
  );
  if (historyCompany) {
    return rejectedCompanyRoleDecision({
      company: historyCompany,
      mentionRole: "candidate-history",
      source,
      speaker,
      mentionedCompanies,
      reason: "company-mentioned-as-candidate-history",
    });
  }

  const affiliationCompany = findInterviewerAffiliationCompany(
    text,
    normalizedText,
    mentionedCompanies
  );
  if (affiliationCompany) {
    return authorizeCompanyMentionForSpeaker({
      company: affiliationCompany,
      confidence: 0.92,
      mentionRole: "interviewer-employer",
      source,
      speaker,
      evidence,
      now,
      mentionedCompanies,
      reason: "bounded-interviewer-affiliation",
    });
  }

  if (mentionedCompanies.length) {
    return rejectedCompanyRoleDecision({
      company: mentionedCompanies[0],
      mentionRole: "unknown",
      source,
      speaker,
      mentionedCompanies,
      reason: "company-mention-has-no-target-authority",
    });
  }

  return noCompanyCandidateDecision(source, speaker);
}

export function formatInterviewCompanyDecisionForTrace(
  decision: InterviewCompanyDetectionDecision | undefined
) {
  const companyValue =
    decision?.candidate?.value ?? decision?.mentionedCompanies[0];
  return {
    companyCandidateDisposition: decision?.disposition ?? "no-candidate",
    companyCandidateMentionRole: decision?.mentionRole ?? "unknown",
    companyCandidateValue: companyValue,
    companyCandidateNormalized:
      decision?.candidate?.normalized ??
      normalizeCompanyHistoryValue(companyValue),
    companyCandidateConfidence: decision?.candidate?.confidence,
    companyCandidateSource: decision?.source,
    companyCandidateSpeaker: decision?.speaker,
    companyCandidateMentionCount:
      decision?.mentionedCompanies.length ?? 0,
    companyCandidateReason: decision?.reason,
  };
}

function companySourceAuthority(source: InterviewSessionContextSource) {
  if (source === "brief") return 4;
  if (source === "manual") return 3;
  if (source === "screen") return 2;
  return 1;
}

function appendCompanyHistory(
  context: InterviewSessionContext,
  decision: InterviewCompanyDetectionDecision
) {
  if (decision.disposition === "no-candidate") return context;
  const occurredAt = decision.candidate?.updatedAt ?? Date.now();
  const company =
    decision.candidate?.value ?? decision.mentionedCompanies[0];
  const historyEntry: InterviewCompanyHistoryEntry = {
    id: `company_history_${occurredAt}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    company,
    normalized:
      decision.candidate?.normalized ??
      normalizeCompanyHistoryValue(company),
    mentionRole: decision.mentionRole,
    disposition: decision.disposition,
    source: decision.source,
    speaker: decision.speaker,
    reason: decision.reason,
    occurredAt,
  };
  return {
    ...context,
    companyHistory: [
      ...(context.companyHistory ?? []),
      historyEntry,
    ].slice(-MAX_COMPANY_HISTORY_ENTRIES),
  };
}

function normalizeCompanyHistoryValue(value: string | undefined) {
  const normalized = normalizeForMatching(value ?? "");
  return normalized ? normalized.replace(/\s+/g, "-") : undefined;
}

function noCompanyCandidateDecision(
  source: InterviewSessionContextSource,
  speaker?: TranscriptSpeaker
): InterviewCompanyDetectionDecision {
  return {
    mentionRole: "unknown",
    disposition: "no-candidate",
    source,
    speaker,
    mentionedCompanies: [],
    reason: "no-company-candidate",
  };
}

function authorizeCompanyMentionForSpeaker({
  company,
  confidence,
  mentionRole,
  source,
  speaker,
  evidence,
  now,
  mentionedCompanies,
  reason,
}: {
  company: CompanyDefinition;
  confidence: number;
  mentionRole: "interview-target" | "interviewer-employer";
  source: InterviewSessionContextSource;
  speaker?: TranscriptSpeaker;
  evidence: string;
  now: number;
  mentionedCompanies: CompanyDefinition[];
  reason: string;
}): InterviewCompanyDetectionDecision {
  const candidate: InterviewTargetCompany = {
    value: company.displayName,
    normalized: company.normalized,
    confidence,
    source,
    evidence: evidence.trim().slice(0, 220),
    updatedAt: now,
  };
  const speakerAuthorized =
    source !== "transcript" || speaker === "them";
  return {
    candidate,
    mentionRole,
    disposition: speakerAuthorized
      ? "candidate-proposed"
      : "candidate-rejected-speaker",
    source,
    speaker,
    mentionedCompanies: uniqueCompanies([
      company,
      ...mentionedCompanies,
    ]).map((mentioned) => mentioned.displayName),
    reason: speakerAuthorized
      ? reason
      : "transcript-company-candidate-requires-interviewer-speaker",
  };
}

function rejectedCompanyRoleDecision({
  company,
  mentionRole,
  source,
  speaker,
  mentionedCompanies,
  reason,
}: {
  company?: CompanyDefinition;
  mentionRole: "candidate-history" | "comparison-only" | "unknown";
  source: InterviewSessionContextSource;
  speaker?: TranscriptSpeaker;
  mentionedCompanies: CompanyDefinition[];
  reason: string;
}): InterviewCompanyDetectionDecision {
  return {
    mentionRole,
    disposition: "candidate-rejected-role",
    source,
    speaker,
    mentionedCompanies: uniqueCompanies([
      ...(company ? [company] : []),
      ...mentionedCompanies,
    ]).map((mentioned) => mentioned.displayName),
    reason,
  };
}

function findKnownCompanyMentions(normalizedText: string) {
  return uniqueCompanies(
    COMPANY_DEFINITIONS.filter((company) =>
      company.aliases.some((alias) =>
        containsNormalizedPhrase(
          normalizedText,
          normalizeForMatching(alias)
        )
      )
    )
  );
}

function findExplicitTargetCompanies(
  originalText: string,
  normalizedText: string
) {
  const targets: CompanyDefinition[] = [];

  for (const company of COMPANY_DEFINITIONS) {
    const matched = company.aliases.some((alias) => {
      const normalizedAlias = normalizeForMatching(alias);
      const aliasPattern = escapeRegExp(normalizedAlias);
      return (
        new RegExp(
          `\\b${aliasPattern}\\s+(?:interview|onsite|loop|round|phone screen|role|position)\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:interviewing|interview|onsite|loop|round|phone screen)\\b.{0,40}\\b(?:with|at|for)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:role|position|opportunity)\\s+(?:with|at|for)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:strong|great|good|excellent|ideal)\\s+fit\\s+(?:for|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText)
      );
    });
    if (matched) targets.push(company);
  }

  const properName =
    "([A-Z][A-Za-z0-9&.+-]*(?:\\s+[A-Z][A-Za-z0-9&.+-]*){0,2})";
  const originalPatterns = [
    new RegExp(
      `\\b(?:interviewing|interview|onsite|loop|round|phone screen)\\s+(?:with|at|for)\\s+${properName}`,
      "g"
    ),
    new RegExp(
      `\\b(?:role|position|opportunity)\\s+(?:with|at|for)\\s+${properName}`,
      "g"
    ),
    new RegExp(
      `\\b(?:strong|great|good|excellent|ideal)\\s+fit\\s+(?:for|with)\\s+${properName}(?:['’]s)?`,
      "g"
    ),
    new RegExp(
      `\\b${properName}(?:['’]s)?\\s+(?:interview|onsite|loop|round|phone screen)\\b`,
      "g"
    ),
  ];
  for (const pattern of originalPatterns) {
    for (const match of originalText.matchAll(pattern)) {
      const company = canonicalizeCompanyName(match[1]);
      if (company) targets.push(company);
    }
  }

  const lowercasePatterns = [
    /\b(?:interviewing|interview|onsite|loop|round|phone screen)\s+(?:with|at|for)\s+([a-z0-9&.+-]+)\b/g,
    /\b(?:role|position|opportunity)\s+(?:with|at|for)\s+([a-z0-9&.+-]+)\b/g,
    /\b(?:strong|great|good|excellent|ideal)\s+fit\s+(?:for|with)\s+([a-z0-9&.+-]+)\b/g,
    /\b([a-z0-9&.+-]+)\s+(?:interview|onsite|loop|round)\b/g,
  ];
  for (const pattern of lowercasePatterns) {
    for (const match of normalizedText.matchAll(pattern)) {
      const company = canonicalizeCompanyName(match[1]);
      if (company) targets.push(company);
    }
  }

  return uniqueCompanies(targets);
}

function findCandidateHistoryCompany(
  normalizedText: string,
  mentionedCompanies: CompanyDefinition[]
) {
  return mentionedCompanies.find((company) =>
    company.aliases.some((alias) => {
      const aliasPattern = escapeRegExp(normalizeForMatching(alias));
      return (
        new RegExp(
          `\\b(?:previously|formerly|used to)\\b.{0,30}\\b(?:at|with|for)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:i|we)\\b.{0,40}\\b(?:worked|built|led|developed|implemented|owned|launched)\\b.{0,40}\\b(?:at|for|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:at|with)\\s+${aliasPattern}\\b.{0,50}\\b(?:i|we)\\b.{0,20}\\b(?:worked|built|led|developed|implemented|owned|launched)\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:my|your)\\s+(?:time|experience|work)\\b.{0,30}\\b(?:at|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:what did you do|work have you done|tell me about your work|your experience)\\b.{0,40}\\b(?:at|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText)
      );
    })
  );
}

function isCompanyComparison(
  normalizedText: string,
  mentionedCompanies: CompanyDefinition[]
) {
  if (!mentionedCompanies.length) return false;
  const hasComparisonMarker =
    /\b(?:compare|compared|comparison|difference|different|differ|versus|vs|unlike|similar|between|as opposed to)\b/.test(
      normalizedText
    );
  return hasComparisonMarker && mentionedCompanies.length >= 1;
}

function findInterviewerAffiliationCompany(
  originalText: string,
  normalizedText: string,
  mentionedCompanies: CompanyDefinition[]
) {
  const knownCompany = mentionedCompanies.find((company) =>
    company.aliases.some((alias) => {
      const aliasPattern = escapeRegExp(normalizeForMatching(alias));
      return (
        new RegExp(
          `\\b(?:i am|i m|im|this is|my name is|we are|we re)\\b.{0,80}\\b(?:from|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:i|we)\\s+(?:work|working|come|coming)\\b.{0,30}\\b(?:at|from|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText) ||
        new RegExp(
          `\\b(?:i am|i m|im|this is|we are|we re)\\b.{0,80}\\b(?:recruiter|hiring manager|manager|engineer)\\b.{0,30}\\b(?:at|from|with)\\s+${aliasPattern}\\b`
        ).test(normalizedText)
      );
    })
  );
  if (knownCompany) return knownCompany;

  const properAffiliation = originalText.match(
    /\b(?:I am|I'm|This is|We are|We're)\b.{0,60}\b(?:from|with)\s+([A-Z][A-Za-z0-9&.+-]*(?:\s+[A-Z][A-Za-z0-9&.+-]*){0,2})/
  )?.[1];
  if (properAffiliation) {
    return canonicalizeCompanyName(properAffiliation);
  }

  const lowercaseAffiliation = normalizedText.match(
    /\b(?:i am|i m|im|this is|we are|we re)\b.{0,60}\b(?:from|with)\s+([a-z0-9&.+-]+)\b/
  )?.[1];
  return canonicalizeCompanyName(lowercaseAffiliation);
}

function canonicalizeCompanyName(
  companyName: string | undefined
): CompanyDefinition | undefined {
  const trimmed = companyName
    ?.trim()
    .replace(/['’]s$/i, "")
    .replace(/[.,:;!?]+$/g, "");
  const normalized = normalizeForMatching(trimmed ?? "");
  if (
    !normalized ||
    /^(?:a|ai|an|and|behavioral|coding|design|diversity|for|ml|our|s|system|technical|the|their|this|today|tomorrow|with|your)$/.test(
      normalized
    )
  ) {
    return undefined;
  }

  const known = COMPANY_DEFINITIONS.find((company) =>
    company.aliases.some(
      (alias) => normalizeForMatching(alias) === normalized
    )
  );
  if (known) return known;

  return {
    displayName: toCompanyDisplayName(trimmed ?? normalized),
    normalized: normalized.replace(/\s+/g, "-"),
    aliases: [normalized],
  };
}

function toCompanyDisplayName(value: string) {
  if (/[A-Z]/.test(value)) return value.trim();
  return value
    .split(/\s+/)
    .map((part) =>
      part.length <= 2
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
    )
    .join(" ");
}

function uniqueCompanies(companies: CompanyDefinition[]) {
  const seen = new Set<string>();
  return companies.filter((company) => {
    if (seen.has(company.normalized)) return false;
    seen.add(company.normalized);
    return true;
  });
}

export function formatInterviewSessionContextForPrompt(
  context: InterviewSessionContext | undefined
) {
  if (!context?.targetCompany) {
    return "No interview session context has been inferred yet.";
  }

  const company = context.targetCompany;
  return [
    `Target company: ${company.value}`,
    `Confidence: ${company.confidence.toFixed(2)}`,
    `Source: ${company.source}`,
    `Evidence: ${company.evidence}`,
    "Use this as session-level interview context. It persists across screen tasks but must not override visible question constraints or explicit transcript corrections.",
  ].join("\n");
}

export function formatInterviewSessionBriefForPrompt(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief || isInterviewSessionBriefEmpty(brief)) {
    return "No interview session brief has been provided.";
  }

  const company = normalizeInterviewBriefCompany(brief.targetCompany);
  return [
    company ? `Target company: ${company.value}` : undefined,
    company
      ? `Company lock: ${brief.companyLocked === false ? "off" : "on"}`
      : undefined,
    brief.interviewTypes.length
      ? `Interview type: ${brief.interviewTypes.join(", ")}`
      : undefined,
    "Use these manual defaults only as routing priors. The selected preparation snapshot, visible screen content, latest spoken constraints, and explicit corrections have higher authority.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildInterviewSessionMemoryHint(
  context: InterviewSessionContext | undefined
) {
  if (!context?.targetCompany) return "";

  const company = context.targetCompany;
  return [
    `interview target company: ${company.value}`,
    `company:${company.normalized}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildInterviewSessionBriefMemoryHint(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief || isInterviewSessionBriefEmpty(brief)) return "";

  const company = normalizeInterviewBriefCompany(brief.targetCompany);
  return [
    "interview session brief",
    company ? `interview target company: ${company.value}` : undefined,
    company ? `company:${company.normalized}` : undefined,
    brief.companyLocked !== false ? "company locked by user brief" : undefined,
    brief.interviewTypes.length
      ? `interview type: ${brief.interviewTypes.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function isInterviewSessionBriefEmpty(
  brief: InterviewSessionBrief | undefined
) {
  if (!brief) return true;
  return (
    !brief.targetCompany.trim() &&
    brief.interviewTypes.length === 0
  );
}

export function classifyAmazonLeadershipPrinciple(
  text: string
): AmazonLeadershipPrincipleHint | undefined {
  const normalizedText = normalizeForMatching(text);
  if (!normalizedText) return undefined;

  let bestHint: AmazonLeadershipPrincipleHint | undefined;
  let bestScore = 0;

  for (const hint of AMAZON_LP_HINTS) {
    const score = hint.markers.reduce(
      (total, marker) =>
        normalizedText.includes(normalizeForMatching(marker))
          ? total + marker.length
          : total,
      0
    );
    if (score > bestScore) {
      bestScore = score;
      bestHint = hint;
    }
  }

  return bestScore > 0 ? bestHint : undefined;
}

export function buildAmazonLeadershipPrincipleMemoryHint(
  context: InterviewSessionContext | undefined,
  text: string
) {
  if (context?.targetCompany?.normalized !== "amazon") return "";
  if (!isLikelyBehavioralInterviewText(text)) return "";

  const hint = classifyAmazonLeadershipPrinciple(text);
  if (!hint) {
    return "amazon leadership principle selector behavioral strength concern";
  }

  return [
    `amazon leadership principle: ${hint.label}`,
    `lp:${hint.id}`,
    hint.reason,
  ].join("\n");
}

function isLikelyBehavioralInterviewText(text: string) {
  const normalizedText = normalizeForMatching(text);
  return (
    /\b(behavior|behaviour|leadership principle|interview story|star)\b/.test(
      normalizedText
    ) ||
    /\b(tell me about|describe|give me an example of)\b.{0,40}\b(a time|when you|your experience|you had to|you were|you did|how you)\b/.test(
      normalizedText
    ) ||
    /\b(a time when|situation where|have you ever|what did you do)\b/.test(
      normalizedText
    ) ||
    /\b(conflict|disagree|failed|missed a commitment|commitment you promised|ownership|bias for action|customer obsession|save costs|eliminate waste)\b/.test(
      normalizedText
    )
  );
}

function normalizeForMatching(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNormalizedPhrase(text: string, phrase: string) {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(text);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
