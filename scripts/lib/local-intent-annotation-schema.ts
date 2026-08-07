import type {
  CorpusSourceIntegrity,
  LocalIntentNormalizedExample,
} from "./local-intent-corpus-schema.js";

export const LOCAL_INTENT_ANNOTATION_SCHEMA_VERSION = 1 as const;

export const SPEECH_ACT_LABELS = [
  "acknowledgement",
  "question",
  "directive",
  "constraint",
  "correction",
  "phase-control",
  "logistics",
  "informational",
] as const;

export const QUESTION_TYPE_LABELS = [
  "behavioral",
  "coding",
  "general-system-design",
  "ai-ml-system-design",
  "project-deep-dive",
  "field-knowledge",
  "unknown",
  "not-applicable",
] as const;

export const PHASE_TRANSITION_INTENTS = [
  "none",
  "hold",
  "advance",
  "revisit",
] as const;

export const PHASE_EVIDENCE_VALUES = ["yes", "no", "unresolved"] as const;
export const SHOULD_ADVISE_VALUES = [
  "advise",
  "do-not-advise",
  "unresolved",
] as const;

export type SpeechActLabel = (typeof SPEECH_ACT_LABELS)[number];
export type QuestionTypeAnnotation =
  | (typeof QUESTION_TYPE_LABELS)[number]
  | "unresolved";
export type PhaseTransitionIntent =
  | (typeof PHASE_TRANSITION_INTENTS)[number]
  | "unresolved";
export type PhaseEvidenceValue = (typeof PHASE_EVIDENCE_VALUES)[number];
export type ShouldAdviseValue = (typeof SHOULD_ADVISE_VALUES)[number];
export type AnnotationPass = "initial" | "blind-repeat" | "adjudication";

export type AnnotationPilotStratum =
  | "clear-technical"
  | "transition-boundary"
  | "discourse-boundary"
  | "phase-correction-constraint";

export interface LocalIntentAnnotationPilotCard {
  schemaVersion: typeof LOCAL_INTENT_ANNOTATION_SCHEMA_VERSION;
  pilotId: string;
  cardId: string;
  ordinal: number;
  exampleId: string;
  sourceUnitId: string;
  sourceHash: string;
  contextHash: string;
  sourceText: string;
  context: {
    previousInterviewerText?: string;
    interveningMeText: string[];
    activeParentType?: string;
    activePhase?: string;
  };
  source: {
    unitKind: LocalIntentNormalizedExample["unitKind"];
    modality: LocalIntentNormalizedExample["modality"];
    language: LocalIntentNormalizedExample["language"];
    materialization: LocalIntentNormalizedExample["provenance"]["materialization"];
    integrity: CorpusSourceIntegrity;
    eligibility: LocalIntentNormalizedExample["eligibility"];
    exactSource: boolean;
  };
}

export interface LocalIntentAnnotationPilotSelectionAudit {
  schemaVersion: typeof LOCAL_INTENT_ANNOTATION_SCHEMA_VERSION;
  pilotId: string;
  cardId: string;
  exampleId: string;
  rootGroupId: string;
  sessionGroupId: string;
  stratum: AnnotationPilotStratum;
  score: number;
  reasons: string[];
  hiddenCandidateIds: string[];
  hiddenCandidateValues: string[];
}

export interface LocalIntentAnnotationPilotManifest {
  schemaVersion: typeof LOCAL_INTENT_ANNOTATION_SCHEMA_VERSION;
  pilotId: string;
  corpusBuildId: string;
  corpusBuilderRevision: string;
  seed: string;
  requestedCards: number;
  selectedCards: number;
  generatedAt: number;
  blinded: true;
  contextPolicy: {
    currentSourceOwnedUnit: true;
    previousInterviewerTurn: true;
    boundedInterveningMeTurns: true;
    activeParentAndPhaseAreNonAuthoritative: true;
    modelAndRuntimePredictionsHidden: true;
  };
  stratumTargets: Record<AnnotationPilotStratum, number>;
  stratumCounts: Record<AnnotationPilotStratum, number>;
  sourceHashes: {
    buildManifest: string;
    normalizedExamples: string;
    labelCandidates: string;
    reviewQueue: string;
    sourceInventory: string;
  };
  cardsHash: string;
  selectionAuditHash: string;
}

export interface LocalIntentAnnotationRecord {
  schemaVersion: typeof LOCAL_INTENT_ANNOTATION_SCHEMA_VERSION;
  annotationId: string;
  pilotId: string;
  cardId: string;
  exampleId: string;
  sourceHash: string;
  contextHash: string;
  annotator: string;
  pass: AnnotationPass;
  revision: number;
  supersedesAnnotationId?: string;
  status: "confirmed" | "skipped";
  labels?: {
    speechAct: {
      primary: SpeechActLabel | "unresolved";
      secondary: SpeechActLabel[];
    };
    questionType: QuestionTypeAnnotation;
    phaseControl: {
      transitionIntent: PhaseTransitionIntent;
      assumptionAuthorized: PhaseEvidenceValue;
      requirementsComplete: PhaseEvidenceValue;
    };
  };
  evaluationFacts?: {
    shouldAdvise: ShouldAdviseValue;
  };
  interaction: {
    startedAt: number;
    submittedAt: number;
    durationMs: number;
  };
}

export interface LocalIntentAnnotationSubmission {
  pilotId: string;
  cardId: string;
  exampleId: string;
  sourceHash: string;
  contextHash: string;
  pass: AnnotationPass;
  status: "confirmed" | "skipped";
  labels?: LocalIntentAnnotationRecord["labels"];
  evaluationFacts?: LocalIntentAnnotationRecord["evaluationFacts"];
  interaction: {
    startedAt: number;
    submittedAt: number;
  };
}

export interface LocalIntentAnnotationProgressReport {
  schemaVersion: typeof LOCAL_INTENT_ANNOTATION_SCHEMA_VERSION;
  pilotId: string;
  totalCards: number;
  completedCards: number;
  skippedCards: number;
  unresolvedCards: number;
  remainingCards: number;
  latestRevisionCount: number;
  speechActCounts: Record<string, number>;
  questionTypeCounts: Record<string, number>;
  transitionIntentCounts: Record<string, number>;
  assumptionAuthorizedCounts: Record<string, number>;
  requirementsCompleteCounts: Record<string, number>;
  shouldAdviseCounts: Record<string, number>;
  blindRepeatCandidateCardIds: string[];
  updatedAt: number;
}
