import type { MemoryQuestionType } from "@/lib/memory";
import type {
  PersonalEvidenceDecision,
  PersonalEvidenceGuardrailMode,
  PersonalEvidenceRequirement,
} from "./types";

export interface DetectPersonalEvidenceInput {
  questionText?: string;
  questionType?: MemoryQuestionType;
  mode?: PersonalEvidenceGuardrailMode;
}

interface SignalMatch {
  label: string;
  pattern: RegExp;
}

const LOGISTICS_SIGNALS: SignalMatch[] = [
  {
    label: "work-authorization",
    pattern: /\b(work authorization|authorized to work|visa status|need sponsorship|require sponsorship)\b/i,
  },
  {
    label: "location-or-relocation",
    pattern: /\b(where are you (?:currently )?located|open to relocat(?:e|ion)|willing to relocat(?:e|ion))\b/i,
  },
  {
    label: "availability-or-start-date",
    pattern: /\b(when can you start|available to start|notice period|start date)\b/i,
  },
  {
    label: "compensation",
    pattern: /\b(compensation expectations?|salary expectations?|expected compensation)\b/i,
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
  if (logisticsSignals.length) {
    return createDecision(
      "personal-logistics",
      0.98,
      logisticsSignals,
      [],
      mode
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
  mode: PersonalEvidenceGuardrailMode
): PersonalEvidenceDecision {
  const confidenceTier =
    confidence >= 0.85 ? "high" : confidence >= 0.55 ? "medium" : "low";
  const enforced =
    mode === "enforcement" &&
    confidenceTier === "high" &&
    (requirement === "autobiographical-project" ||
      requirement === "autobiographical-behavioral");

  return {
    requirement,
    confidence,
    confidenceTier,
    signals,
    counterSignals,
    mode,
    enforced,
  };
}

function collectSignals(text: string, signals: SignalMatch[]) {
  return signals
    .filter((signal) => signal.pattern.test(text))
    .map((signal) => signal.label);
}

function normalizeQuestionText(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}
