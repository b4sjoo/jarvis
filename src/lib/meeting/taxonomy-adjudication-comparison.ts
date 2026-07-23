import type {
  InterviewerEvidenceMode,
  InterviewerIntentAction,
  InterviewerIntentRelation,
  InterviewerSpeechAct,
} from "./interviewer-intent.js";
import { projectEvidenceMode } from "./interviewer-intent.js";
import type { PrimaryAskProjection } from "./primary-ask-projection.js";
import type {
  LlmTaxonomyAdjudication,
} from "./taxonomy-adjudication.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";

export type TaxonomyAdjudicationRepairFactor =
  | "speech-act"
  | "question-type"
  | "relation"
  | "evidence-mode"
  | "action"
  | "primary-ask";

export interface LocalInterviewerIntentBaseline {
  speechAct?: InterviewerSpeechAct;
  questionType: CanonicalQuestionType;
  relation: InterviewerIntentRelation;
  evidenceMode: InterviewerEvidenceMode;
  action?: InterviewerIntentAction;
  normalizedPrimaryAsk?: string;
}

export function buildLocalInterviewerIntentBaseline(input: {
  questionType: CanonicalQuestionType;
  relation: InterviewerIntentRelation;
  turnGateAction: string;
  primaryAskProjection?: PrimaryAskProjection;
}): LocalInterviewerIntentBaseline {
  return {
    speechAct: input.primaryAskProjection?.speechAct,
    questionType: input.questionType,
    relation: input.relation,
    evidenceMode: projectEvidenceMode(input.questionType),
    action: mapTurnGateAction(input.turnGateAction),
    normalizedPrimaryAsk:
      input.primaryAskProjection?.normalizedPrimaryAsk?.trim() || undefined,
  };
}

export function compareTaxonomyAdjudicationToLocalBaseline(input: {
  adjudication: LlmTaxonomyAdjudication | undefined;
  baseline: LocalInterviewerIntentBaseline;
}) {
  const { adjudication, baseline } = input;
  const factors: TaxonomyAdjudicationRepairFactor[] = [];
  if (!adjudication) return { wouldRepair: false, factors };

  if (
    baseline.speechAct &&
    adjudication.speechAct !== baseline.speechAct
  ) {
    factors.push("speech-act");
  }
  if (adjudication.questionType !== baseline.questionType) {
    factors.push("question-type");
  }
  if (adjudication.relation !== baseline.relation) {
    factors.push("relation");
  }
  if (adjudication.evidenceMode !== baseline.evidenceMode) {
    factors.push("evidence-mode");
  }
  if (baseline.action && adjudication.action !== baseline.action) {
    factors.push("action");
  }
  if (
    normalize(adjudication.normalizedQuestion) !==
    normalize(baseline.normalizedPrimaryAsk ?? "")
  ) {
    factors.push("primary-ask");
  }

  return {
    wouldRepair: factors.length > 0,
    factors,
  };
}

function mapTurnGateAction(
  action: string
): InterviewerIntentAction | undefined {
  if (action === "answer-refresh") return "answer";
  if (action === "append-only" || action === "state-update") {
    return "append-context";
  }
  if (action === "ignore") return "ignore";
  if (action === "buffer") return "buffer";
  return undefined;
}

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}
