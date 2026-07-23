import type {
  AdvisorTurnGateAction,
  AdvisorTurnIntent,
  AdvisorTurnIntentDecision,
} from "./advisor-turn-intent.js";
import type { CanonicalQuestionType } from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";

export type InterviewerSpeechAct =
  | "question"
  | "directive"
  | "constraint"
  | "correction"
  | "acknowledgement"
  | "section-transition"
  | "logistics"
  | "informational";

export type InterviewerIntentRelation =
  | "new-parent"
  | "followup-parent"
  | "child-probe"
  | "linked-parent-extension"
  | "none";

export type InterviewerEvidenceMode =
  | "personal-experience"
  | "hypothetical-design"
  | "factual-explanation"
  | "unknown";

export type InterviewerIntentAction =
  | "answer"
  | "append-context"
  | "buffer"
  | "ignore";

export interface InterviewerIntentEvidenceSpan {
  turnId: string;
  text: string;
}

export interface InterviewerIntentDecision {
  schemaVersion: 1;
  speechAct: InterviewerSpeechAct;
  questionType: CanonicalQuestionType;
  relation: InterviewerIntentRelation;
  evidenceMode: InterviewerEvidenceMode;
  action: InterviewerIntentAction;
  contextTurnIds: string[];
  evidenceSpans: InterviewerIntentEvidenceSpan[];
  confidence: number;
}

export interface ProjectInterviewerIntentInput {
  turnDecision: AdvisorTurnIntentDecision;
  questionType?: CanonicalQuestionType;
  relation?: InterviewTaskRelation | "linked-parent-extension";
  contextTurnIds?: string[];
  evidenceSpans?: InterviewerIntentEvidenceSpan[];
}

export function projectInterviewerIntentDecision({
  turnDecision,
  questionType = "unknown",
  relation,
  contextTurnIds = [],
  evidenceSpans = [],
}: ProjectInterviewerIntentInput): InterviewerIntentDecision {
  return {
    schemaVersion: 1,
    speechAct: projectSpeechAct(turnDecision.intent),
    questionType,
    relation: projectIntentRelation(relation),
    evidenceMode: projectEvidenceMode(questionType),
    action: projectIntentAction(turnDecision.intent, turnDecision.action),
    contextTurnIds: uniqueStrings(contextTurnIds),
    evidenceSpans: uniqueEvidenceSpans(evidenceSpans),
    confidence: clampConfidence(turnDecision.confidence),
  };
}

export function projectSpeechAct(
  intent: AdvisorTurnIntent
): InterviewerSpeechAct {
  switch (intent) {
    case "direct-question":
      return "question";
    case "constraint-or-follow-up":
      return "constraint";
    case "correction":
      return "correction";
    case "confirmation":
      return "acknowledgement";
    case "logistics":
      return "logistics";
    case "informational":
    case "incomplete":
    case "unknown":
      return "informational";
  }
}

export function projectIntentRelation(
  relation:
    | InterviewTaskRelation
    | "linked-parent-extension"
    | undefined
): InterviewerIntentRelation {
  switch (relation) {
    case "new-parent":
      return "new-parent";
    case "followup-parent":
    case "resume-parent":
    case "correction":
      return "followup-parent";
    case "child-probe":
      return "child-probe";
    case "linked-parent-extension":
      return "linked-parent-extension";
    case "logistics":
    case "unknown":
    case undefined:
      return "none";
  }
}

export function projectEvidenceMode(
  questionType: CanonicalQuestionType
): InterviewerEvidenceMode {
  switch (questionType) {
    case "behavioral":
    case "project-deep-dive":
      return "personal-experience";
    case "coding":
    case "general-system-design":
    case "ai-ml-system-design":
      return "hypothetical-design";
    case "field-knowledge":
      return "factual-explanation";
    case "unknown":
      return "unknown";
  }
}

export function projectIntentAction(
  intent: AdvisorTurnIntent,
  action: AdvisorTurnGateAction
): InterviewerIntentAction {
  if (intent === "incomplete") return "buffer";
  switch (action) {
    case "answer-refresh":
      return "answer";
    case "append-only":
    case "state-update":
      return "append-context";
    case "ignore":
      return "ignore";
  }
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueEvidenceSpans(values: InterviewerIntentEvidenceSpan[]) {
  const seen = new Set<string>();
  return values.filter((span) => {
    if (!span.turnId || !span.text.trim()) return false;
    const key = `${span.turnId}:${span.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
