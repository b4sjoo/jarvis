import type { MemoryQuestionType } from "@/lib/memory";
import type {
  PersonalEvidenceDecision,
  PersonalEvidenceGuardrailMode,
  PersonalEvidenceRequirement,
  PersonalEvidenceStatusDomain,
} from "./types";

export interface DetectPersonalEvidenceInput {
  questionText?: string;
  questionType?: MemoryQuestionType;
  mode?: PersonalEvidenceGuardrailMode;
}

interface SignalMatch {
  label: string;
  pattern: RegExp;
  statusDomain?: PersonalEvidenceStatusDomain;
}

const LOGISTICS_SIGNALS: SignalMatch[] = [
  {
    label: "work-authorization",
    pattern:
      /\b(?:(?:are|will|would|do) you.{0,48}(?:authorized to work|work authorization|visa status|need sponsorship|require sponsorship)|what is your (?:work authorization|visa status)|(?:will|do) you (?:now or in the future )?(?:need|require) sponsorship)\b/i,
    statusDomain: "work-authorization",
  },
  {
    label: "location-or-relocation",
    pattern: /\b(where are you (?:currently )?located|open to relocat(?:e|ion)|willing to relocat(?:e|ion))\b/i,
    statusDomain: "location-relocation",
  },
  {
    label: "availability-or-start-date",
    pattern: /\b(when can you start|available to start|notice period|start date)\b/i,
    statusDomain: "availability-start-date",
  },
  {
    label: "compensation",
    pattern:
      /\b(?:your (?:compensation|salary) expectations?|what (?:compensation|salary) (?:are you|do you) expect|what is your expected compensation)\b/i,
    statusDomain: "compensation",
  },
  {
    label: "employment-status",
    pattern: /\b(are you (?:currently )?employed|what is your current employment status|are you still working (?:at|for))\b/i,
    statusDomain: "employment-status",
  },
];

const HEALTH_STATUS_SIGNALS: SignalMatch[] = [
  {
    label: "personal-health-check-in",
    pattern:
      /\b(?:how (?:are|is) your|how about your) (?:health|condition|recovery|symptoms?|palpitations?|pain|injury|illness|treatment)\b/i,
    statusDomain: "health-status",
  },
  {
    label: "personal-health-persistence",
    pattern:
      /\b(?:are you still|do you still) (?:having|experiencing|dealing with|recovering from|suffering from) (?:[a-z][a-z -]{1,60})\b/i,
    statusDomain: "health-status",
  },
  {
    label: "personal-health-change",
    pattern:
      /\b(?:has|have) your (?:health|condition|recovery|symptoms?|palpitations?|pain|injury|illness) (?:improved|resolved|changed|gotten better|got worse|returned)\b/i,
    statusDomain: "health-status",
  },
  {
    label: "personal-health-possession",
    pattern:
      /\bdo you (?:currently |still )?(?:have|experience) (?:palpitations?|symptoms?|a medical condition|a health condition)\b/i,
    statusDomain: "health-status",
  },
];

const BEHAVIORAL_SIGNALS: SignalMatch[] = [
  {
    label: "tell-me-about-a-time",
    pattern: /\b(?:tell me about|describe|give me an example of) (?:a )?time (?:when )?you\b/i,
  },
  {
    label: "past-personal-example",
    pattern: /\b(?:when have you|when did you|have you ever)\b/i,
  },
  {
    label: "personal-decision-or-conflict",
    pattern: /\b(?:example of (?:how|when) you|situation (?:where|in which) you)\b/i,
  },
];

const PROJECT_SIGNALS: SignalMatch[] = [
  {
    label: "direct-past-implementation",
    pattern: /\b(?:what|which) did you (?:implement|build|design|own|ship|test|validate|deploy|launch|monitor|measure)\b/i,
  },
  {
    label: "past-implementation-method",
    pattern: /\bhow did you (?:implement|build|design|test|validate|deploy|launch|monitor|measure|scale|operate|debug)\b/i,
  },
  {
    label: "personal-role-or-contribution",
    pattern: /\b(?:what was|describe) your (?:role|contribution|responsibilit(?:y|ies)|impact|ownership)\b/i,
  },
  {
    label: "direct-contribution",
    pattern: /\b(?:your contribution|your role in|your impact on)\b/i,
  },
  {
    label: "personal-project-or-experience",
    pattern: /\b(?:tell me about|walk me through|describe) your (?:project|system|experience|implementation|architecture|work)\b/i,
  },
  {
    label: "past-professional-action",
    pattern: /\b(?:have you|did you) (?:build|ship|deploy|implement|work on|own|test|validate|launch|operate|monitor)\b/i,
  },
  {
    label: "past-tool-or-method-choice",
    pattern: /\bdid you (?:use|choose|select|adopt)\b/i,
  },
  {
    label: "collaboration-history",
    pattern: /\bwho did you work with\b/i,
  },
];

const MEDIUM_PERSONAL_SIGNALS: SignalMatch[] = [
  {
    label: "personal-experience-topic",
    pattern: /\b(?:your experience|your background|your work) (?:with|on|in)\b/i,
  },
  {
    label: "personal-learning",
    pattern: /\bwhat did you learn\b/i,
  },
  {
    label: "personal-impact",
    pattern: /\bwhat (?:was|is) the impact of your\b/i,
  },
];

const HYPOTHETICAL_COUNTER_SIGNALS: SignalMatch[] = [
  {
    label: "hypothetical-how-would",
    pattern: /\bhow would you\b/i,
  },
  {
    label: "hypothetical-what-would",
    pattern: /\bwhat would you\b/i,
  },
  {
    label: "hypothetical-should",
    pattern: /\b(?:how|what) should (?:you|we|the system)\b/i,
  },
  {
    label: "design-request",
    pattern: /\b(?:design|implement|build) (?:a|an|the)\b/i,
  },
  {
    label: "explicit-hypothetical",
    pattern: /\b(?:suppose|imagine|hypothetically|in general)\b/i,
  },
];

export function detectPersonalEvidenceRequirement({
  questionText,
  questionType,
  mode = "enforcement",
}: DetectPersonalEvidenceInput): PersonalEvidenceDecision {
  const normalized = normalizeQuestionText(questionText);
  if (!normalized) {
    return createDecision("not-required", 0, [], [], mode);
  }

  const logisticsSignals = collectSignals(normalized, LOGISTICS_SIGNALS);
  const healthStatusSignals = collectSignals(normalized, HEALTH_STATUS_SIGNALS);
  const personalStatusSignals = [...logisticsSignals, ...healthStatusSignals];
  if (personalStatusSignals.length) {
    const statusDomain =
      findStatusDomain(normalized, [
        ...LOGISTICS_SIGNALS,
        ...HEALTH_STATUS_SIGNALS,
      ]) ?? undefined;
    return createDecision(
      "personal-logistics",
      0.98,
      personalStatusSignals,
      [],
      mode,
      statusDomain
    );
  }

  const behavioralSignals = collectSignals(normalized, BEHAVIORAL_SIGNALS);
  const projectSignals = collectSignals(normalized, PROJECT_SIGNALS);
  const mediumSignals = collectSignals(normalized, MEDIUM_PERSONAL_SIGNALS);
  const counterSignals = collectSignals(
    normalized,
    HYPOTHETICAL_COUNTER_SIGNALS
  );

  if (behavioralSignals.length) {
    return createDecision(
      "autobiographical-behavioral",
      0.96,
      behavioralSignals,
      counterSignals,
      mode
    );
  }

  if (projectSignals.length) {
    return createDecision(
      "autobiographical-project",
      0.95,
      projectSignals,
      counterSignals,
      mode
    );
  }

  if (counterSignals.length) {
    return createDecision(
      "not-required",
      0.94,
      [],
      counterSignals,
      mode
    );
  }

  if (mediumSignals.length) {
    const requirement =
      questionType === "behavioral"
        ? "autobiographical-behavioral"
        : "autobiographical-project";
    return createDecision(
      requirement,
      0.67,
      mediumSignals,
      [],
      mode
    );
  }

  return createDecision("not-required", 0.9, [], [], mode);
}

function createDecision(
  requirement: PersonalEvidenceRequirement,
  confidence: number,
  signals: string[],
  counterSignals: string[],
  mode: PersonalEvidenceGuardrailMode,
  statusDomain?: PersonalEvidenceStatusDomain
): PersonalEvidenceDecision {
  const confidenceTier =
    confidence >= 0.85 ? "high" : confidence >= 0.55 ? "medium" : "low";
  const enforced =
    mode === "enforcement" &&
    confidenceTier === "high" &&
    (requirement === "autobiographical-project" ||
      requirement === "autobiographical-behavioral" ||
      requirement === "personal-logistics");

  return {
    requirement,
    confidence,
    confidenceTier,
    signals,
    counterSignals,
    statusDomain,
    allowedEvidenceSources:
      requirement === "personal-logistics"
        ? ["interview-brief", "profile-memory", "confirmed-me"]
        : [],
    mode,
    enforced,
  };
}

function collectSignals(text: string, signals: SignalMatch[]) {
  return signals
    .filter((signal) => signal.pattern.test(text))
    .map((signal) => signal.label);
}

function findStatusDomain(text: string, signals: SignalMatch[]) {
  return signals.find((signal) => signal.pattern.test(text))?.statusDomain;
}

function normalizeQuestionText(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}
