import type {
  InterviewSessionBrief,
  InterviewSessionContext,
  InterviewSessionContextSource,
  InterviewTargetCompany,
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

const INTERVIEW_CONTEXT_MARKERS = [
  "interview",
  "interviewer",
  "candidate",
  "hiring",
  "recruiter",
  "onsite",
  "phone screen",
  "loop",
  "round",
  "behavioral",
  "behavioural",
  "coding round",
  "system design",
  "role",
  "position",
  "today's discussion",
  "thanks for joining",
  "thank you for joining",
  "welcome",
];

const TARGET_COMPANY_LOCK_CONFIDENCE = 0.9;

export interface InterviewSessionUpdate {
  context: InterviewSessionContext;
  changed: boolean;
  targetCompany?: InterviewTargetCompany;
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
  const detectedCompany = detectInterviewCompany(turn.text, now, "transcript");
  return updateInterviewSessionContextWithDetectedCompany(
    currentContext,
    detectedCompany
  );
}

export function updateInterviewSessionContextFromScreenText(
  currentContext: InterviewSessionContext | undefined,
  text: string,
  evidence = text,
  now = Date.now()
): InterviewSessionUpdate {
  const detectedCompany = detectInterviewCompany(text, now, "screen", evidence);
  return updateInterviewSessionContextWithDetectedCompany(
    currentContext,
    detectedCompany
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

function updateInterviewSessionContextWithDetectedCompany(
  currentContext: InterviewSessionContext | undefined,
  detectedCompany: InterviewTargetCompany | undefined
): InterviewSessionUpdate {
  const context = currentContext ? { ...currentContext } : {};

  if (!detectedCompany) {
    return { context, changed: false };
  }

  const previous = context.targetCompany;
  const shouldReplace = shouldReplaceTargetCompany(previous, detectedCompany);

  if (!shouldReplace) {
    return { context, changed: false };
  }

  context.targetCompany = detectedCompany;
  return { context, changed: true, targetCompany: detectedCompany };
}

function shouldReplaceTargetCompany(
  previous: InterviewTargetCompany | undefined,
  detectedCompany: InterviewTargetCompany
) {
  if (!previous) return true;
  if (detectedCompany.normalized === previous.normalized) return true;
  if (previous.confidence >= TARGET_COMPANY_LOCK_CONFIDENCE) return false;

  return (
    detectedCompany.confidence >= 0.95 &&
    detectedCompany.confidence > previous.confidence + 0.05
  );
}

export function detectInterviewCompany(
  text: string,
  now = Date.now(),
  source: InterviewSessionContextSource = "transcript",
  evidence = text
): InterviewTargetCompany | undefined {
  const normalizedText = normalizeForMatching(text);
  if (!normalizedText) return undefined;

  const hasInterviewMarker = INTERVIEW_CONTEXT_MARKERS.some((marker) =>
    normalizedText.includes(marker)
  );

  const candidates = COMPANY_DEFINITIONS.flatMap((company) =>
    company.aliases.map((alias) => {
      const normalizedAlias = normalizeForMatching(alias);
      if (!containsNormalizedPhrase(normalizedText, normalizedAlias)) {
        return undefined;
      }

      const hasCompanyInterviewPhrase =
        normalizedText.includes(`${normalizedAlias} interview`) ||
        normalizedText.includes(`${normalizedAlias} round`) ||
        normalizedText.includes(`${normalizedAlias} loop`) ||
        normalizedText.includes(`${normalizedAlias} onsite`) ||
        normalizedText.includes(`${normalizedAlias} phone screen`) ||
        normalizedText.includes(`${normalizedAlias} role`) ||
        normalizedText.includes(`${normalizedAlias} position`);
      const hasInterviewerIntro = new RegExp(
        `\\b(i am|i m|im|this is|my name is|we are|we re)\\b.{0,80}\\b(from|at|with)\\s+${escapeRegExp(
          normalizedAlias
        )}\\b`
      ).test(normalizedText) ||
        new RegExp(
          `\\b(i|we)\\b.{0,30}\\b(work|working|worked|come|coming)\\b.{0,40}\\b(at|from|with)\\s+${escapeRegExp(
            normalizedAlias
          )}\\b`
        ).test(normalizedText);
      const hasTargetPhrase = new RegExp(
        `\\b(interviewing|interview|onsite|loop|round|phone screen)\\b.{0,40}\\b(with|at|for)\\s+${escapeRegExp(
          normalizedAlias
        )}\\b`
      ).test(normalizedText);
      const hasScreenCompanyPhrase =
        source === "screen" &&
        new RegExp(
          `\\b(from|for|at)\\s+${escapeRegExp(normalizedAlias)}\\b`
        ).test(normalizedText);

      let confidence = 0;
      if (hasCompanyInterviewPhrase || hasTargetPhrase) {
        confidence = 0.95;
      } else if (hasInterviewerIntro) {
        confidence = 0.92;
      } else if (hasScreenCompanyPhrase) {
        confidence = 0.9;
      } else if (hasInterviewMarker) {
        confidence = 0.72;
      }

      if (!confidence) return undefined;

      return {
        company,
        confidence,
        aliasLength: normalizedAlias.length,
      };
    })
  ).filter(Boolean) as Array<{
    company: CompanyDefinition;
    confidence: number;
    aliasLength: number;
  }>;

  const bestCandidate = candidates.sort(
    (left, right) =>
      right.confidence - left.confidence || right.aliasLength - left.aliasLength
  )[0];
  if (!bestCandidate) return undefined;

  return {
    value: bestCandidate.company.displayName,
    normalized: bestCandidate.company.normalized,
    confidence: bestCandidate.confidence,
    source,
    evidence: evidence.trim().slice(0, 220),
    updatedAt: now,
  };
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
    brief.focusAreas.trim()
      ? `Expected focus: ${brief.focusAreas.trim()}`
      : undefined,
    brief.notes.trim() ? `Notes: ${brief.notes.trim()}` : undefined,
    "Use this as user-provided pre-meeting background context. It can guide retrieval and answer style, but visible screen content and latest spoken constraints still win.",
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
    brief.focusAreas.trim() ? `focus areas: ${brief.focusAreas.trim()}` : undefined,
    brief.notes.trim() ? `brief notes: ${brief.notes.trim()}` : undefined,
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
    brief.interviewTypes.length === 0 &&
    !brief.focusAreas.trim() &&
    !brief.notes.trim()
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
  return [
    "behavior",
    "behaviour",
    "leadership principle",
    "tell me about",
    "give me an example",
    "example of how",
    "a time when",
    "situation",
    "conflict",
    "disagree",
    "decision",
    "tradeoff",
    "trade off",
    "ownership",
    "save costs",
    "eliminate waste",
    "question bank",
    "interview story",
  ].some((marker) => normalizedText.includes(marker));
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
