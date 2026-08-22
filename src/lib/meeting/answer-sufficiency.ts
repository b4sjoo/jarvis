import type { CanonicalQuestionType } from "./task-taxonomy.js";
import type { ContextScopeResponseActionResult } from "./context-scope-response-action.js";
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

export type AnswerResolutionState =
  | "resolved"
  | "awaiting-evidence"
  | "failed";

export interface AnswerResolutionProjection {
  state: AnswerResolutionState;
  awaitingVisualEvidence: boolean;
  evidence: string[];
}

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
  semanticStatus?: "context-insufficient" | "not-context-insufficient";
  semanticConfidence?: number;
  semanticMargin?: number;
  semanticDurationMs?: number;
  semanticDisposition?: string;
  semanticRejectionReasons?: string[];
  expectedArtifactKinds: AnswerArtifactKind[];
  missingArtifactKinds: AnswerArtifactKind[];
  resolvableByNearbyContext: boolean;
  candidateContextKinds: string[];
  candidateSourceTurnIds: string[];
  contextDeltaChars: number;
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
    contextDeltaChars: 0,
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

/**
 * Projects the existing sufficiency reasons into the small runtime contract
 * used by recovery. This does not grant relation or task mutation authority.
 */
export function projectAnswerResolution(input: {
  decision: AnswerSufficiencyDecision;
  questionText: string;
  parsedAnswer: ParsedMeetingAnswer;
}): AnswerResolutionProjection {
  const question = normalize(input.questionText);
  const answer = normalize(collectAnswerText(input.parsedAnswer));
  const visualReferenceEvidence = matchLabels(
    question,
    VISUAL_REFERENCE_PATTERNS
  );
  const missingVisualEvidence = matchLabels(
    answer,
    MISSING_VISUAL_EVIDENCE_PATTERNS
  );
  const awaitingVisualEvidence =
    visualReferenceEvidence.length > 0 &&
    missingVisualEvidence.length > 0;

  if (awaitingVisualEvidence) {
    return {
      state: "awaiting-evidence",
      awaitingVisualEvidence: true,
      evidence: uniqueStrings([
        ...visualReferenceEvidence,
        ...missingVisualEvidence,
      ]),
    };
  }

  if (input.decision.answerStatus === "sufficient") {
    return {
      state: "resolved",
      awaitingVisualEvidence: false,
      evidence: ["answer-sufficient"],
    };
  }

  if (
    input.decision.answerStatus === "context-insufficient" ||
    input.decision.answerStatus === "clarification-needed" ||
    input.decision.answerStatus === "fact-anchor-missing" ||
    input.decision.answerStatus === "legitimate-wait"
  ) {
    return {
      state: "awaiting-evidence",
      awaitingVisualEvidence: false,
      evidence: [`answer-${input.decision.answerStatus}`],
    };
  }

  return {
    state: "failed",
    awaitingVisualEvidence: false,
    evidence: [`answer-${input.decision.answerStatus}`],
  };
}

export interface EvaluateAnswerContextResolvabilityInput {
  decision: AnswerSufficiencyDecision;
  selection: ContextScopeResponseActionResult;
  questionType: CanonicalQuestionType;
  activeParentQuestionType?: CanonicalQuestionType;
  originalSourceTurnIds?: string[];
  originalContextText: string;
  sourceTextByTurnId: Readonly<Record<string, string>>;
}

export function evaluateAnswerContextResolvabilityShadow(
  input: EvaluateAnswerContextResolvabilityInput
): AnswerSufficiencyDecision {
  if (input.decision.answerStatus !== "context-insufficient") {
    return input.decision;
  }

  const originalContext = normalize(input.originalContextText);
  const originalSourceTurnIds = new Set(input.originalSourceTurnIds ?? []);
  const selectedCandidates = input.selection.candidates.filter(
    (candidate) => candidate.selected && candidate.kind !== "current-lqu"
  );
  const novelTurnIds = uniqueStrings(
    selectedCandidates.flatMap((candidate) =>
      candidate.turnIds.filter((turnId) => {
        if (originalSourceTurnIds.has(turnId)) return false;
        const sourceText = normalize(input.sourceTextByTurnId[turnId] ?? "");
        return sourceText.length > 0 && !originalContext.includes(sourceText);
      })
    )
  );
  const candidatesWithNovelEvidence = selectedCandidates.filter((candidate) =>
    candidate.turnIds.some((turnId) => novelTurnIds.includes(turnId))
  );
  const typeCompatible =
    !input.activeParentQuestionType ||
    input.activeParentQuestionType === "unknown" ||
    input.questionType === "unknown" ||
    input.activeParentQuestionType === input.questionType ||
    !candidatesWithNovelEvidence.some(
      (candidate) => candidate.kind === "parent-capsule"
    );
  const plausibleEvidence = candidatesWithNovelEvidence.filter((candidate) =>
    candidateCanResolveDefect(candidate, input.decision.contextDefect)
  );
  const resolvable =
    !input.selection.independentQuestionGuardApplied &&
    typeCompatible &&
    plausibleEvidence.length > 0;
  const candidateKinds = uniqueStrings(
    plausibleEvidence.map((candidate) => candidate.kind)
  );
  const candidateSourceTurnIds = uniqueStrings(
    plausibleEvidence.flatMap((candidate) =>
      candidate.turnIds.filter((turnId) => novelTurnIds.includes(turnId))
    )
  );
  const contextDeltaChars = candidateSourceTurnIds.reduce(
    (total, turnId) =>
      total + (input.sourceTextByTurnId[turnId]?.trim().length ?? 0),
    0
  );

  return {
    ...input.decision,
    recommendedRepair: resolvable ? "enhance" : "manual-clarification",
    resolvableByNearbyContext: resolvable,
    candidateContextKinds: candidateKinds,
    candidateSourceTurnIds,
    contextDeltaChars,
    lexicalEvidence: uniqueStrings([
      ...input.decision.lexicalEvidence,
      ...(input.selection.independentQuestionGuardApplied
        ? ["context-independent-question-guard"]
        : []),
      ...(!typeCompatible ? ["context-question-type-mismatch"] : []),
      ...(selectedCandidates.length > 0 && novelTurnIds.length === 0
        ? ["context-candidates-already-present"]
        : []),
      ...(resolvable ? ["source-backed-context-delta"] : []),
    ]),
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
    answerSufficiencySemanticStatus: decision.semanticStatus,
    answerSufficiencySemanticConfidence: decision.semanticConfidence,
    answerSufficiencySemanticMargin: decision.semanticMargin,
    answerSufficiencySemanticDurationMs: decision.semanticDurationMs,
    answerSufficiencySemanticDisposition:
      decision.semanticDisposition,
    answerSufficiencySemanticRejectionReasons:
      decision.semanticRejectionReasons,
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
    contextDeltaChars: decision.contextDeltaChars,
  };
}

export function buildAnswerSufficiencySemanticText(input: {
  questionText: string;
  parsedAnswer: ParsedMeetingAnswer;
  maxChars?: number;
}) {
  const maxChars = Math.max(320, input.maxChars ?? 1_600);
  const question = input.questionText.trim();
  const answer = [
    input.parsedAnswer.sections.answer,
    input.parsedAnswer.sections.approach,
    input.parsedAnswer.sections.clarifyingQuestion,
    input.parsedAnswer.sections.code
      ? "[code artifact present]"
      : undefined,
    input.parsedAnswer.sections.whiteboard
      ? "[whiteboard artifact present]"
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return `Question: ${question}\nAnswer: ${answer}`.slice(0, maxChars);
}

function candidateCanResolveDefect(
  candidate: ContextScopeResponseActionResult["candidates"][number],
  defect: AnswerContextDefect
) {
  if (candidate.score < 0.5 || candidate.chars <= 0) return false;
  if (
    defect === "missing-antecedent" ||
    defect === "fragmented-question"
  ) {
    return (
      candidate.kind === "recent-dialogue" ||
      candidate.kind === "child-capsule" ||
      candidate.kind === "parent-capsule"
    );
  }
  if (
    defect === "underspecified-action" ||
    defect === "artifact-placeholder"
  ) {
    return (
      /\b(?:task|question|input|output|constraint|code|script|implement|diagram|whiteboard|architecture)\b|题目|任务|输入|输出|约束|代码|脚本|实现|架构图|白板/u.test(
        normalize(candidate.text)
      ) && candidate.score >= 0.56
    );
  }
  return candidate.score >= 0.62;
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

const VISUAL_REFERENCE_PATTERNS: Array<[string, RegExp]> = [
  [
    "question-references-code-lines",
    /\blines?\s+\d+(?:\s*(?:-|–|—|through|to)\s*\d+)?\b|第\s*\d+\s*(?:到|至|-|–|—)\s*\d+\s*行|第\s*\d+\s*行/u,
  ],
  [
    "question-references-visual-code-location",
    /\b(?:this|that|the highlighted|the selected)\s+(?:function|method|class|block|section|snippet|code)\b|(?:这个|那个|高亮|选中)(?:函数|方法|类|代码块|片段|代码)/u,
  ],
  [
    "question-references-named-code-identifier",
    /\b(?:function|method|class|variable|identifier|field)\s+[`"']?[a-z_$][\w$.-]*[`"']?/u,
  ],
];

const MISSING_VISUAL_EVIDENCE_PATTERNS: Array<[string, RegExp]> = [
  [
    "answer-cannot-inspect-visual-evidence",
    /\b(?:i\s+)?(?:cannot|can't|do not|don't)\s+(?:see|view|access|read|inspect)\s+(?:the\s+|those\s+|these\s+)?(?:code|lines?|screenshot|image|snippet|implementation)\b|\b(?:the\s+)?(?:code|lines?|screenshot|image|snippet)\s+(?:is|are)\s+not\s+(?:visible|available|shown|provided)\b|(?:看不到|无法查看|无法读取|未显示)(?:这些|对应|相关)?(?:代码|行号|截图|图片|片段)/u,
  ],
  [
    "answer-requests-visual-evidence",
    /\b(?:please\s+)?(?:share|paste|upload|provide|show|send)\s+(?:the\s+|those\s+|these\s+|relevant\s+)?(?:code|lines?|screenshot|image|snippet|implementation)\b|\b(?:i\s+)?need\s+(?:to\s+see\s+)?(?:the\s+|those\s+|these\s+)?(?:code|lines?|screenshot|image|snippet)\b|(?:请|需要)(?:先)?(?:分享|粘贴|上传|提供|展示)(?:对应|相关|这些)?(?:代码|行号|截图|图片|片段)/u,
  ],
];

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
  ...MISSING_VISUAL_EVIDENCE_PATTERNS,
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

function uniqueStrings(values: Array<string | undefined>) {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.length > 0
      )
    ),
  ];
}
