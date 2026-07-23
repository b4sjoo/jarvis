import type { AdvisorTurnIntentDecision } from "./advisor-turn-intent.js";
import {
  projectInterviewerIntentDecision,
  type InterviewerIntentDecision,
} from "./interviewer-intent.js";
import {
  inferQuestionTypeDecisionFromText,
  type QuestionTypeInferenceDecision,
} from "./task-taxonomy.js";
import type { InterviewTaskRelation } from "./types.js";

export interface InterviewerIntentKeywordEvidence {
  schemaVersion: 1;
  speechActMarkers: string[];
  actionVerbs: string[];
  actionObjects: string[];
  temporalFrames: string[];
  domainMarkers: string[];
  transitionMarkers: string[];
  hardNegativeMarkers: string[];
  questionTypeDecision: QuestionTypeInferenceDecision;
  counterfactual: InterviewerIntentDecision;
}

export interface ExtractInterviewerIntentKeywordEvidenceInput {
  text: string;
  turnDecision: AdvisorTurnIntentDecision;
  relation?: InterviewTaskRelation | "linked-parent-extension";
  contextTurnIds?: string[];
  currentTurnId?: string;
}

export function extractInterviewerIntentKeywordEvidence({
  text,
  turnDecision,
  relation,
  contextTurnIds = [],
  currentTurnId,
}: ExtractInterviewerIntentKeywordEvidenceInput): InterviewerIntentKeywordEvidence {
  const normalized = normalize(text);
  const questionTypeDecision = inferQuestionTypeDecisionFromText(text);
  const speechActMarkers = unique([
    ...turnDecision.evidence.filter((entry) =>
      /question|task-frame|confirmation|constraint|correction|logistics|declarative|incomplete|ambiguous/.test(
        entry
      )
    ),
    ...matchLabels(normalized, SPEECH_ACT_PATTERNS),
  ]);
  const contextIds = unique([
    ...contextTurnIds,
    ...(currentTurnId ? [currentTurnId] : []),
  ]);

  return {
    schemaVersion: 1,
    speechActMarkers,
    actionVerbs: matchTerms(normalized, ACTION_VERBS),
    actionObjects: matchTerms(normalized, ACTION_OBJECTS),
    temporalFrames: matchLabels(normalized, TEMPORAL_FRAME_PATTERNS),
    domainMarkers: matchLabels(normalized, DOMAIN_PATTERNS),
    transitionMarkers: matchLabels(normalized, TRANSITION_PATTERNS),
    hardNegativeMarkers: unique([
      ...matchLabels(normalized, HARD_NEGATIVE_PATTERNS),
      ...questionTypeDecision.evidence.filter((entry) =>
        /blocked|ambiguous|weak/.test(entry)
      ),
    ]),
    questionTypeDecision,
    counterfactual: projectInterviewerIntentDecision({
      turnDecision,
      questionType: questionTypeDecision.type ?? "unknown",
      relation,
      contextTurnIds: contextIds,
      evidenceSpans: currentTurnId
        ? [{ turnId: currentTurnId, text: text.trim() }]
        : [],
    }),
  };
}

export function formatInterviewerIntentKeywordEvidenceForTrace(
  evidence: InterviewerIntentKeywordEvidence
) {
  return {
    interviewerIntentKeywordEvidenceSchemaVersion: evidence.schemaVersion,
    interviewerIntentKeywordSpeechActMarkers: evidence.speechActMarkers,
    interviewerIntentKeywordActionVerbs: evidence.actionVerbs,
    interviewerIntentKeywordActionObjects: evidence.actionObjects,
    interviewerIntentKeywordTemporalFrames: evidence.temporalFrames,
    interviewerIntentKeywordDomainMarkers: evidence.domainMarkers,
    interviewerIntentKeywordTransitionMarkers: evidence.transitionMarkers,
    interviewerIntentKeywordHardNegativeMarkers: evidence.hardNegativeMarkers,
    interviewerIntentKeywordQuestionType:
      evidence.questionTypeDecision.type ?? "unknown",
    interviewerIntentKeywordQuestionTypeConfidence:
      evidence.questionTypeDecision.confidence,
    interviewerIntentKeywordQuestionTypeMargin:
      evidence.questionTypeDecision.margin,
    interviewerIntentKeywordQuestionTypeEvidence:
      evidence.questionTypeDecision.evidence,
    interviewerIntentCounterfactual: evidence.counterfactual,
  };
}

const SPEECH_ACT_PATTERNS: Array<[string, RegExp]> = [
  ["wh-question", /\b(?:what|why|when|where|which|who|how)\b|什么|为什么|何时|哪里|哪个|谁|如何|怎么/u],
  ["yes-no-question", /\b(?:can|could|would|should|do|does|did|is|are|will|have|has)\b/u],
  ["imperative-frame", /\b(?:tell|give|show|explain|describe|design|implement|write|estimate|compare|discuss)\b|请|解释|描述|设计|实现|编写|估算|比较/u],
  ["acknowledgement", /\b(?:yes|yeah|right|okay|ok|good|great|thanks)\b|好的|明白|可以|谢谢/u],
  ["correction-frame", /\b(?:actually|instead|rather|correction|i mean|not)\b|更正|不是|改成/u],
];

const ACTION_VERBS = [
  "build",
  "code",
  "compare",
  "create",
  "describe",
  "design",
  "discuss",
  "estimate",
  "evaluate",
  "explain",
  "implement",
  "optimize",
  "propose",
  "show",
  "solve",
  "write",
  "实现",
  "写",
  "设计",
  "解释",
  "描述",
  "比较",
  "估算",
];

const ACTION_OBJECTS = [
  "algorithm",
  "api",
  "architecture",
  "class",
  "code",
  "data structure",
  "database",
  "function",
  "infrastructure",
  "method",
  "model",
  "pipeline",
  "platform",
  "queue",
  "service",
  "stack",
  "system",
  "tree",
  "算法",
  "代码",
  "数据结构",
  "系统",
  "架构",
  "模型",
];

const TEMPORAL_FRAME_PATTERNS: Array<[string, RegExp]> = [
  ["past-experience", /\b(?:did you|have you|when you|a time|your previous|you built|you implemented)\b|你曾经|过去|之前/u],
  ["hypothetical", /\b(?:how would you|suppose|assume|imagine|design a|build a)\b|假设|如果|你会如何/u],
  ["current-follow-up", /\b(?:now|next|then|also|instead|what about|how about)\b|现在|接下来|然后|另外|改成/u],
];

const DOMAIN_PATTERNS: Array<[string, RegExp]> = [
  ["coding-domain", /\b(?:algorithm|array|code|function|leetcode|queue|stack|tree)\b|算法|代码|数组|队列|栈|树/u],
  ["system-design-domain", /\b(?:architecture|database|distributed|qps|service|system design|throughput)\b|架构|数据库|分布式|系统设计|吞吐/u],
  ["ai-ml-domain", /\b(?:ai|embedding|llm|machine learning|model|rag|ranking|recommendation|retrieval)\b|机器学习|模型|向量|检索|推荐/u],
  ["behavioral-domain", /\b(?:conflict|leadership|mistake|persuade|tell me about a time)\b|冲突|领导力|错误|说服/u],
  ["project-domain", /\b(?:your project|your contribution|you built|you implemented|your role)\b|你的项目|你的贡献|你的角色/u],
];

const TRANSITION_PATTERNS: Array<[string, RegExp]> = [
  ["explicit-section-transition", /\b(?:let'?s|we can|now|next)\s+(?:move|switch|look|talk|start)\b|接下来|现在我们|换到/u],
  ["type-announcement", /\b(?:coding|behavioral|system design|machine learning|project)\s+(?:question|section|part)\b|算法题|行为题|系统设计|项目深挖/u],
];

const HARD_NEGATIVE_PATTERNS: Array<[string, RegExp]> = [
  ["past-project-not-hypothetical", /\b(?:how did you|what did you|your contribution|your role|you built|you implemented)\b|你当时|你做了什么/u],
  ["concept-not-implementation", /\b(?:what is|explain the concept|how does .* work)\b|什么是|原理是什么/u],
  ["acknowledgement-prefix", /^(?:yes|yeah|right|okay|ok|good|great|thanks)\b|^(?:好的|明白|可以|谢谢)/u],
  ["indirect-question-clause", /\b(?:discussed|explained|mentioned)\s+(?:what|why|where|how)\b|讨论了|解释了|提到了/u],
];

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function matchLabels(
  text: string,
  patterns: Array<[string, RegExp]>
) {
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

function matchTerms(text: string, terms: string[]) {
  return terms.filter((term) =>
    /[\u3400-\u9fff]/u.test(term)
      ? text.includes(term)
      : new RegExp(`\\b${escapeRegExp(term)}\\b`, "u").test(text)
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]) {
  return [...new Set(values)];
}
