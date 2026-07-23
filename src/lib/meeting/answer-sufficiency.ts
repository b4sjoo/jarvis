import type { CanonicalQuestionType } from "./task-taxonomy.js";
import type {
  MeetingAnswerProfile,
  ParsedMeetingAnswer,
} from "./types.js";

export type AnswerSufficiencyStatus =
  | "sufficient"
  | "context-insufficient"
  | "legitimate-wait"
  | "clarification-needed"
  | "fact-anchor-missing"
  | "execution-failure"
  | "unknown";

export type AnswerContextDefect =
  | "none"
  | "missing-antecedent"
  | "fragmented-question"
  | "underspecified-action"
  | "unresolved-slot"
  | "artifact-placeholder"
  | "generic-meta-fallback"
  | "prior-parent-leakage"
  | "recent-correction-contradiction";

export type AnswerRepairRecommendation =
  | "none"
  | "enhance"
  | "narrow"
  | "buffer"
  | "ignore"
  | "wait"
  | "manual-clarification";

export type AnswerArtifactKind = "code" | "whiteboard" | "complexity";

export interface AnswerSufficiencyDecision {
  schemaVersion: 1;
  detectorVersion: string;
  operationId: string;
  traceId: string;
  questionId: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  answerStatus: AnswerSufficiencyStatus;
  contextDefect: AnswerContextDefect;
  recommendedRepair: AnswerRepairRecommendation;
  confidence: number;
  lexicalEvidence: string[];
  semanticPrototypeIds: string[];
  expectedArtifactKinds: AnswerArtifactKind[];
  missingArtifactKinds: AnswerArtifactKind[];
  resolvableByNearbyContext: boolean;
  candidateContextKinds: string[];
  candidateSourceTurnIds: string[];
  createdAt: number;
}

export interface DetectAnswerSufficiencyInput {
  operationId: string;
  traceId: string;
  questionId: string;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  answerRevision: number;
  questionText: string;
  questionType: CanonicalQuestionType;
  answerProfile?: MeetingAnswerProfile;
  parsedAnswer: ParsedMeetingAnswer;
  executionStatus?: "success" | "error" | "timeout" | "truncated";
  factAnchorRequired?: boolean;
  factAnchorAvailable?: boolean;
  currentTurnAction?: "answer" | "append-context" | "buffer" | "ignore";
  createdAt?: number;
}

export const ANSWER_SUFFICIENCY_DETECTOR_VERSION =
  "answer-sufficiency-lexical-v1";

export function detectAnswerSufficiencyShadow(
  input: DetectAnswerSufficiencyInput
): AnswerSufficiencyDecision {
  const expectedArtifactKinds = inferExpectedArtifacts(input);
  const missingArtifactKinds = expectedArtifactKinds.filter(
    (kind) => !hasArtifact(input.parsedAnswer, kind)
  );
  const normalizedAnswer = normalize(collectAnswerText(input.parsedAnswer));
  const normalizedQuestion = normalize(input.questionText);
  const lexicalEvidence: string[] = [];
  const base = {
    schemaVersion: 1 as const,
    detectorVersion: ANSWER_SUFFICIENCY_DETECTOR_VERSION,
    operationId: input.operationId,
    traceId: input.traceId,
    questionId: input.questionId,
    logicalQuestionUnitId: input.logicalQuestionUnitId,
    logicalQuestionUnitRevision: input.logicalQuestionUnitRevision,
    answerRevision: input.answerRevision,
    lexicalEvidence,
    semanticPrototypeIds: [] as string[],
    expectedArtifactKinds,
    missingArtifactKinds,
    resolvableByNearbyContext: false,
    candidateContextKinds: [] as string[],
    candidateSourceTurnIds: [] as string[],
    createdAt: input.createdAt ?? Date.now(),
  };

  if (
    input.executionStatus === "error" ||
    input.executionStatus === "timeout" ||
    input.executionStatus === "truncated" ||
    input.parsedAnswer.parseStatus === "partial"
  ) {
    lexicalEvidence.push(
      input.executionStatus
        ? `execution-${input.executionStatus}`
        : "partial-answer-contract"
    );
    return {
      ...base,
      answerStatus: "execution-failure",
      contextDefect: "none",
      recommendedRepair: "none",
      confidence: 1,
    };
  }

  if (input.factAnchorRequired && !input.factAnchorAvailable) {
    lexicalEvidence.push("required-fact-anchor-unavailable");
    return {
      ...base,
      answerStatus: "fact-anchor-missing",
      contextDefect: "unresolved-slot",
      recommendedRepair: "manual-clarification",
      confidence: 1,
    };
  }

  const missingContextSignals = matchLabels(
    normalizedAnswer,
    MISSING_CONTEXT_PATTERNS
  );
  lexicalEvidence.push(...missingContextSignals);

  if (
    missingContextSignals.length > 0 &&
    isLegitimateWaitQuestion(normalizedQuestion)
  ) {
    lexicalEvidence.push("question-is-section-transition-without-task");
    return {
      ...base,
      answerStatus: "legitimate-wait",
      contextDefect: "none",
      recommendedRepair: "wait",
      confidence: 0.98,
    };
  }

  if (
    input.currentTurnAction === "buffer" ||
    isIncompleteQuestion(normalizedQuestion)
  ) {
    lexicalEvidence.push("current-question-incomplete-or-buffered");
    return {
      ...base,
      answerStatus: "legitimate-wait",
      contextDefect: "fragmented-question",
      recommendedRepair: "buffer",
      confidence: 0.96,
    };
  }

  if (
    missingContextSignals.length > 0 &&
    isMaterialClarification(input.parsedAnswer, input.questionType)
  ) {
    lexicalEvidence.push("material-clarifying-question-present");
    return {
      ...base,
      answerStatus: "clarification-needed",
      contextDefect: "unresolved-slot",
      recommendedRepair: "manual-clarification",
      confidence: 0.92,
    };
  }

  const substantiveAsk = isSubstantiveAsk(normalizedQuestion);
  const concreteAnswer = hasConcretePrimaryAnswer(input.parsedAnswer);
  const missingRequestedArtifact = missingArtifactKinds.length > 0;
  if (
    missingContextSignals.length > 0 &&
    substantiveAsk &&
    (!concreteAnswer || missingRequestedArtifact)
  ) {
    if (!concreteAnswer) lexicalEvidence.push("no-concrete-primary-answer");
    if (missingRequestedArtifact) {
      lexicalEvidence.push(
        ...missingArtifactKinds.map((kind) => `missing-${kind}-artifact`)
      );
    }
    return {
      ...base,
      answerStatus: "context-insufficient",
      contextDefect: inferContextDefect(
        normalizedQuestion,
        missingRequestedArtifact
      ),
      recommendedRepair: "enhance",
      confidence: missingContextSignals.length > 1 ? 0.98 : 0.94,
    };
  }

  if (hasUsefulAnswer(input.parsedAnswer)) {
    return {
      ...base,
      answerStatus: "sufficient",
      contextDefect: "none",
      recommendedRepair: "none",
      confidence: 0.82,
    };
  }

  return {
    ...base,
    answerStatus: "unknown",
    contextDefect: "none",
    recommendedRepair: "none",
    confidence: 0.35,
  };
}

export function formatAnswerSufficiencyDecisionForTrace(
  decision: AnswerSufficiencyDecision
) {
  return {
    answerSufficiencySchemaVersion: decision.schemaVersion,
    answerSufficiencyDetectorVersion: decision.detectorVersion,
    answerSufficiencyOperationId: decision.operationId,
    answerSufficiencyStatus: decision.answerStatus,
    answerContextDefect: decision.contextDefect,
    answerRepairRecommendation: decision.recommendedRepair,
    answerSufficiencyConfidence: decision.confidence,
    answerSufficiencyLexicalEvidence: decision.lexicalEvidence,
    answerSufficiencySemanticPrototypeIds:
      decision.semanticPrototypeIds,
    answerExpectedArtifacts: decision.expectedArtifactKinds,
    answerMissingArtifacts: decision.missingArtifactKinds,
    answerSufficiencyLogicalQuestionUnitId:
      decision.logicalQuestionUnitId,
    answerSufficiencyLogicalQuestionUnitRevision:
      decision.logicalQuestionUnitRevision,
    answerSufficiencyAnswerRevision: decision.answerRevision,
    contextResolvable: decision.resolvableByNearbyContext,
    contextCandidateKinds: decision.candidateContextKinds,
    contextCandidateSourceTurnIds:
      decision.candidateSourceTurnIds,
  };
}

function inferExpectedArtifacts(
  input: DetectAnswerSufficiencyInput
): AnswerArtifactKind[] {
  const text = normalize(input.questionText);
  const expected = new Set<AnswerArtifactKind>();
  if (
    input.questionType === "coding" &&
    /\b(?:code|implement|implementation|script|function|class|write)\b|代码|实现|脚本|函数/u.test(
      text
    )
  ) {
    expected.add("code");
  }
  if (
    input.questionType === "coding" &&
    /\b(?:complexity|big o|time and space)\b|复杂度/u.test(text)
  ) {
    expected.add("complexity");
  }
  if (
    (input.questionType === "general-system-design" ||
      input.questionType === "ai-ml-system-design") &&
    /\b(?:draw|diagram|whiteboard|architecture figure)\b|画图|架构图|白板/u.test(
      text
    )
  ) {
    expected.add("whiteboard");
  }
  return [...expected];
}

function hasArtifact(
  parsed: ParsedMeetingAnswer,
  kind: AnswerArtifactKind
) {
  return Boolean(parsed.sections[kind]?.trim());
}

function collectAnswerText(parsed: ParsedMeetingAnswer) {
  return [
    parsed.sections.answer,
    parsed.sections.approach,
    parsed.sections.clarifyingQuestion,
  ]
    .filter(Boolean)
    .join("\n");
}

function hasConcretePrimaryAnswer(parsed: ParsedMeetingAnswer) {
  const answer = normalize(parsed.sections.answer ?? "");
  if (!answer || answer === "-") return false;
  if (matchLabels(answer, MISSING_CONTEXT_PATTERNS).length > 0) {
    return false;
  }
  return answer.length >= 40;
}

function hasUsefulAnswer(parsed: ParsedMeetingAnswer) {
  return Boolean(
    hasConcretePrimaryAnswer(parsed) ||
      parsed.sections.code?.trim() ||
      parsed.sections.whiteboard?.trim()
  );
}

function isMaterialClarification(
  parsed: ParsedMeetingAnswer,
  questionType: CanonicalQuestionType
) {
  const clarification = normalize(
    parsed.sections.clarifyingQuestion ?? ""
  );
  if (!clarification) return false;
  if (
    questionType !== "coding" &&
    questionType !== "general-system-design" &&
    questionType !== "ai-ml-system-design"
  ) {
    return false;
  }
  return (
    /\b(?:scale|traffic|qps|latency|consistency|scope|input|output|constraint|language|availability)\b|规模|流量|延迟|一致性|范围|输入|输出|约束|语言|可用性/u.test(
      clarification
    ) || clarification.length >= 24
  );
}

function isSubstantiveAsk(text: string) {
  const wordEquivalent = Math.max(
    (text.match(/[a-z0-9]+/giu) ?? []).length,
    Math.ceil((text.match(/[\u3400-\u9fff]/gu) ?? []).length / 2)
  );
  return (
    wordEquivalent >= 3 &&
    (/\b(?:what|why|when|where|which|who|how|can|could|would|should|do|does|did|is|are|will|have|has)\b|什么|为什么|哪里|如何|怎么|多少|能否|是否/u.test(
      text
    ) ||
      /\b(?:tell|give|show|explain|describe|design|implement|write|estimate|compare|discuss|find|return)\b|请|解释|描述|设计|实现|编写|估算|比较|查找|返回/u.test(
        text
      ))
  );
}

function isLegitimateWaitQuestion(text: string) {
  return (
    /^(?:okay |ok |now |next |so )?(?:let'?s |we(?:'ll| will) )?(?:move|switch|start|look at|talk about)(?: on| to)? (?:the )?(?:next )?(?:coding|behavioral|system design|machine learning|project)(?: question| section| part)?[.!]?$/u.test(
      text
    ) ||
    /^(?:接下来|现在)(?:我们)?(?:进入|开始|看|聊)(?:下一部分)?(?:算法题|行为题|系统设计|机器学习|项目)(?:部分)?[。！]?$/u.test(
      text
    )
  );
}

function isIncompleteQuestion(text: string) {
  return (
    !text ||
    /\b(?:and then|which is|so that|because|if we|when we)\s*$/u.test(
      text
    ) ||
    /(?:然后|也就是|所以|因为|如果|当我们)\s*$/u.test(text)
  );
}

function inferContextDefect(
  question: string,
  missingRequestedArtifact: boolean
): AnswerContextDefect {
  if (missingRequestedArtifact) return "artifact-placeholder";
  if (
    /\b(?:that|it|same|this|earlier|previous|continue)\b|这个|那个|同样|继续|刚才|之前/u.test(
      question
    )
  ) {
    return "missing-antecedent";
  }
  if (
    /\b(?:script|code|implementation|do it)\b|脚本|代码|实现/u.test(
      question
    )
  ) {
    return "underspecified-action";
  }
  return "generic-meta-fallback";
}

const MISSING_CONTEXT_PATTERNS: Array<[string, RegExp]> = [
  [
    "missing-original-problem",
    /\b(?:i (?:do not|don't) have|without|missing) (?:the )?(?:original|base|full) (?:problem|question|prompt)\b/u,
  ],
  [
    "transcript-missing-problem",
    /\b(?:the )?transcript (?:does not|doesn't) (?:state|include|contain) (?:the )?(?:problem|task|question)\b/u,
  ],
  [
    "specific-task-unclear",
    /\b(?:specific|exact) (?:[\w-]+ )?(?:task|goal|input\/?output|requirement)s?(?: (?:and|or) (?:the )?(?:[\w-]+ )?(?:task|goal|input\/?output|requirement)s?)* (?:is|are|isn't|aren't|is not|are not) (?:clear|defined|specified|known)\b/u,
  ],
  [
    "pending-problem-statement",
    /\b(?:pending|waiting for|once (?:the )?(?:problem|task|goal) is known)\b/u,
  ],
  [
    "need-task-clarification",
    /\b(?:what exactly should (?:it|the script|the code) do|need (?:the )?(?:original problem|task definition|full question)|need (?:one|a) clarification before (?:writing|designing|implementing))\b/u,
  ],
  [
    "missing-context-zh",
    /(?:没有原题|缺少(?:可执行的)?题目定义|缺少目标|无法写(?:出)?正确(?:的)?(?:脚本|代码)|要先确认原题|没有足够上下文(?:来)?确定)/u,
  ],
];

function matchLabels(
  text: string,
  patterns: Array<[string, RegExp]>
) {
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
