import type { ActiveMeetingTask } from "./active-meeting-task";
import type { LogicalQuestionUnit } from "./logical-question-unit";
import type {
  AdvisorPromptContext,
  MeetingContextState,
  TranscriptTurn,
} from "./types";

export const CONTEXT_SCOPE_MAX_RECENT_THEM_TURNS = 5;
export const CONTEXT_SCOPE_MAX_EXPANSION_CHARS = 1_600;
export const CONTEXT_SCOPE_MAX_CAPSULE_CHARS = 500;

export type ContextScopeResponseAction =
  | "narrow-context"
  | "enhance-context";

export type ContextScopeMode = "current-only" | "expanded";

export type ContextScopeQuestionRelation =
  | "independent-new-question"
  | "continuation"
  | "referential-follow-up"
  | "unknown";

export type ContextScopeCandidateKind =
  | "current-lqu"
  | "recent-dialogue"
  | "child-capsule"
  | "parent-capsule";

export interface ContextScopeSelectionBudgets {
  maxRecentThemTurns: number;
  maxExpansionChars: number;
  maxCapsuleChars: number;
}

export interface ContextScopeCompositionInput {
  baseContext: AdvisorPromptContext;
  logicalQuestionUnit: LogicalQuestionUnit;
  meetingContext: MeetingContextState;
  activeMeetingTask?: ActiveMeetingTask;
  questionRelation?: ContextScopeQuestionRelation;
  budgets?: Partial<ContextScopeSelectionBudgets>;
}

export interface ContextScopeResponseActionRequest
  extends ContextScopeCompositionInput {
  action: ContextScopeResponseAction;
}

export interface ContextScopeCandidate {
  kind: ContextScopeCandidateKind;
  text: string;
  turnIds: string[];
  chars: number;
  score: number;
  selected: boolean;
  reason: string;
  rejectedReason?: string;
}

export interface ContextScopeResponseActionResult {
  action: ContextScopeResponseAction;
  contextScopeMode: ContextScopeMode;
  promptContext: AdvisorPromptContext;
  logicalQuestionUnitId: string;
  logicalQuestionUnitRevision: number;
  candidates: ContextScopeCandidate[];
  selectedKinds: ContextScopeCandidateKind[];
  selectedTurnIds: string[];
  selectedChars: number;
  selectedScores: Partial<Record<ContextScopeCandidateKind, number>>;
  selectionReason: string;
  independentQuestionGuardApplied: boolean;
  budgets: ContextScopeSelectionBudgets;
}

export function composeContextScopeAdvisorPromptContext(
  request: ContextScopeResponseActionRequest
): ContextScopeResponseActionResult {
  return request.action === "narrow-context"
    ? composeCurrentOnlyAdvisorPromptContext(request)
    : composeExpandedAdvisorPromptContext(request);
}

export function composeCurrentOnlyAdvisorPromptContext(
  input: ContextScopeCompositionInput
): ContextScopeResponseActionResult {
  const budgets = resolveBudgets(input.budgets);
  const current = buildCurrentQuestionCandidate(input.logicalQuestionUnit);
  const task = resolveActiveMeetingTask(input);
  const promptContext = buildSafePromptContext({
    baseContext: input.baseContext,
    logicalQuestionUnit: input.logicalQuestionUnit,
    meetingContext: input.meetingContext,
    activeMeetingTask: task,
    selectedCandidates: [current],
    preserveTaskProcedure: true,
  });

  return buildResult({
    action: "narrow-context",
    mode: "current-only",
    promptContext,
    logicalQuestionUnit: input.logicalQuestionUnit,
    candidates: [current],
    selectionReason: "current-logical-question-only",
    independentQuestionGuardApplied: false,
    budgets,
  });
}

export function composeExpandedAdvisorPromptContext(
  input: ContextScopeCompositionInput
): ContextScopeResponseActionResult {
  const budgets = resolveBudgets(input.budgets);
  const current = buildCurrentQuestionCandidate(input.logicalQuestionUnit);
  const task = resolveActiveMeetingTask(input);
  const relation = resolveQuestionRelation(input);
  const independentQuestionGuardApplied =
    relation === "independent-new-question";
  const expansionCandidates = buildExpansionCandidates(
    input,
    task,
    budgets
  );

  let selectionReason = "no-additional-relevant-context";
  let selectedExpansions: ContextScopeCandidate[] = [];

  if (independentQuestionGuardApplied) {
    for (const candidate of expansionCandidates) {
      candidate.rejectedReason = "independent-question-stale-context-guard";
    }
    selectionReason = "independent-question-current-only";
  } else {
    selectedExpansions = selectShortestSufficientCandidates(
      expansionCandidates,
      relation,
      budgets.maxExpansionChars
    );
    if (selectedExpansions.length === 1) {
      selectionReason = `shortest-sufficient-${selectedExpansions[0].kind}`;
    } else if (selectedExpansions.length > 1) {
      selectionReason = "combined-bounded-context";
    }
  }

  const selected = [current, ...selectedExpansions];
  const promptContext = buildSafePromptContext({
    baseContext: input.baseContext,
    logicalQuestionUnit: input.logicalQuestionUnit,
    meetingContext: input.meetingContext,
    activeMeetingTask: independentQuestionGuardApplied ? undefined : task,
    selectedCandidates: selected,
    preserveTaskProcedure: !independentQuestionGuardApplied,
  });

  return buildResult({
    action: "enhance-context",
    mode: "expanded",
    promptContext,
    logicalQuestionUnit: input.logicalQuestionUnit,
    candidates: [current, ...expansionCandidates],
    selectionReason,
    independentQuestionGuardApplied,
    budgets,
  });
}

function buildExpansionCandidates(
  input: ContextScopeCompositionInput,
  task: ActiveMeetingTask | undefined,
  budgets: ContextScopeSelectionBudgets
) {
  const candidates: ContextScopeCandidate[] = [];
  const recent = buildRecentDialogueCandidate(input, budgets);
  if (recent) candidates.push(recent);

  const child = buildChildCapsuleCandidate(input, task, budgets);
  if (child) candidates.push(child);

  const parent = buildParentCapsuleCandidate(input, task, budgets);
  if (parent) candidates.push(parent);

  return candidates;
}

function buildCurrentQuestionCandidate(
  logicalQuestionUnit: LogicalQuestionUnit
): ContextScopeCandidate {
  const text = [
    `Current logical question (id=${logicalQuestionUnit.id}, revision=${logicalQuestionUnit.revision}):`,
    `Them: ${normalizeText(logicalQuestionUnit.normalizedText)}`,
  ].join("\n");

  return {
    kind: "current-lqu",
    text,
    turnIds: uniqueStrings(logicalQuestionUnit.sourceTurnIds),
    chars: text.length,
    score: 1,
    selected: true,
    reason: "required-current-logical-question",
  };
}

function buildRecentDialogueCandidate(
  input: ContextScopeCompositionInput,
  budgets: ContextScopeSelectionBudgets
): ContextScopeCandidate | undefined {
  const unit = input.logicalQuestionUnit;
  const sourceTurnIds = new Set(unit.sourceTurnIds);
  const precedingThemTurns = input.meetingContext.transcriptTurns
    .filter(
      (turn) =>
        turn.speaker === "them" &&
        turn.isFinal &&
        !sourceTurnIds.has(turn.id) &&
        turn.endedAt <= unit.startedAt
    )
    .sort(compareTurns)
    .slice(-budgets.maxRecentThemTurns);

  if (precedingThemTurns.length === 0) return undefined;

  const earliestStartedAt = precedingThemTurns[0].startedAt;
  const relevantMeTurns = input.meetingContext.transcriptTurns.filter(
    (turn) =>
      turn.speaker === "me" &&
      turn.isFinal &&
      !sourceTurnIds.has(turn.id) &&
      turn.startedAt >= earliestStartedAt &&
      turn.endedAt <= unit.startedAt &&
      isRelevantInterleavedMeTurn(
        turn,
        precedingThemTurns,
        input.logicalQuestionUnit
      )
  );
  const heading = "Recent source dialogue:";
  const bounded = formatBoundedTurnWindow(
    [...precedingThemTurns, ...relevantMeTurns].sort(compareTurns),
    Math.max(1, budgets.maxExpansionChars - heading.length - 1)
  );
  if (!bounded.text) return undefined;
  const candidateText = `${heading}\n${bounded.text}`;

  const referential = hasReferentialEvidence(unit.normalizedText);
  const lexicalScore = lexicalSimilarity(
    unit.normalizedText,
    precedingThemTurns.map((turn) => turn.text).join(" ")
  );
  const score = clampScore(
    0.18 +
      lexicalScore * 0.34 +
      (referential ? 0.48 : 0) +
      (relevantMeTurns.length > 0 ? 0.06 : 0)
  );

  return {
    kind: "recent-dialogue",
    text: candidateText,
    turnIds: bounded.turnIds,
    chars: candidateText.length,
    score,
    selected: false,
    reason: referential
      ? "recent-dialogue-referential-evidence"
      : "recent-dialogue-lexical-evidence",
  };
}

function buildChildCapsuleCandidate(
  input: ContextScopeCompositionInput,
  task: ActiveMeetingTask | undefined,
  budgets: ContextScopeSelectionBudgets
): ContextScopeCandidate | undefined {
  const child = task?.child;
  if (!child) return undefined;

  const sourceTurns = findTurnsById(
    input.meetingContext,
    child.basedOnTurnIds
  );
  const sourceText = sourceTurns
    .map((turn) => `${formatSpeaker(turn)}: ${normalizeText(turn.text)}`)
    .join("\n");
  const capsule = truncateText(
    [
      "Source-only child probe:",
      `Question type: ${child.questionType}`,
      `Intent: ${child.intent}`,
      `Question: ${normalizeText(child.question)}`,
      sourceText ? `Source turns:\n${sourceText}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    budgets.maxCapsuleChars
  );
  if (!capsule) return undefined;

  const lexicalScore = lexicalSimilarity(
    input.logicalQuestionUnit.normalizedText,
    [child.question, sourceText].join(" ")
  );
  const childReference = hasChildReferenceEvidence(
    input.logicalQuestionUnit.normalizedText,
    child.question
  );

  return {
    kind: "child-capsule",
    text: capsule,
    turnIds: uniqueStrings(child.basedOnTurnIds),
    chars: capsule.length,
    score: clampScore(
      0.16 + lexicalScore * 0.52 + (childReference ? 0.56 : 0)
    ),
    selected: false,
    reason: childReference
      ? "active-child-reference-evidence"
      : "active-child-lexical-evidence",
  };
}

function buildParentCapsuleCandidate(
  input: ContextScopeCompositionInput,
  task: ActiveMeetingTask | undefined,
  budgets: ContextScopeSelectionBudgets
): ContextScopeCandidate | undefined {
  if (!task) return undefined;

  const parent = task.parent;
  const parentSourceTurnIds = uniqueStrings([
    ...(parent.canonicalQuestionSourceTurnIds ?? []),
    parent.startTurnId,
  ]);
  const sourceTurns = findTurnsById(
    input.meetingContext,
    parentSourceTurnIds
  );
  const sourceText = sourceTurns
    .map((turn) => `${formatSpeaker(turn)}: ${normalizeText(turn.text)}`)
    .join("\n");
  const screenQuestion = normalizeText(task.screen?.question ?? "");
  const handoffLines = buildSourceBackedHandoffLines(task);

  if (!sourceText && !screenQuestion && handoffLines.length === 0) {
    return undefined;
  }

  const capsule = truncateText(
    [
      "Source-only parent task:",
      `Question type: ${parent.questionType}`,
      `Playbook phase: ${parent.playbookPhase}`,
      sourceText ? `Source turns:\n${sourceText}` : undefined,
      screenQuestion ? `Screen question: ${screenQuestion}` : undefined,
      ...handoffLines,
    ]
      .filter(Boolean)
      .join("\n"),
    budgets.maxCapsuleChars
  );
  const parentEvidenceText = [
    sourceText,
    screenQuestion,
    handoffLines.join(" "),
  ].join(" ");
  const lexicalScore = lexicalSimilarity(
    input.logicalQuestionUnit.normalizedText,
    parentEvidenceText
  );
  const parentReference = hasParentReferenceEvidence(
    input.logicalQuestionUnit.normalizedText
  );

  return {
    kind: "parent-capsule",
    text: capsule,
    turnIds: parentSourceTurnIds,
    chars: capsule.length,
    score: clampScore(
      0.15 + lexicalScore * 0.48 + (parentReference ? 0.48 : 0)
    ),
    selected: false,
    reason: parentReference
      ? "parent-task-scope-evidence"
      : "parent-task-lexical-evidence",
  };
}

function buildSourceBackedHandoffLines(task: ActiveMeetingTask) {
  const handoff = task.parent.parentContextHandoff;
  if (!handoff) return [];

  const scenario = handoff.sharedScenarioContext;
  return [
    scenario.productIdentity
      ? `Shared product: ${normalizeText(scenario.productIdentity)}`
      : undefined,
    scenario.domainEntities?.length
      ? `Shared entities: ${scenario.domainEntities
          .map(normalizeText)
          .filter(Boolean)
          .join(", ")}`
      : undefined,
    scenario.sharedRequirements?.length
      ? `Accepted shared requirements: ${scenario.sharedRequirements
          .map(normalizeText)
          .filter(Boolean)
          .join("; ")}`
      : undefined,
    scenario.applicableScaleAssumptions?.length
      ? `Accepted scale assumptions: ${scenario.applicableScaleAssumptions
          .map((item) => normalizeText(item.value))
          .filter(Boolean)
          .join("; ")}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
}

function selectShortestSufficientCandidates(
  candidates: ContextScopeCandidate[],
  relation: ContextScopeQuestionRelation,
  maxExpansionChars: number
) {
  const sufficientThreshold =
    relation === "referential-follow-up" ? 0.54 : 0.6;
  const sufficientCandidates = candidates.filter(
      (candidate) =>
        candidate.score >= sufficientThreshold &&
        candidate.chars <= maxExpansionChars
    );
  const strongestScore = Math.max(
    0,
    ...sufficientCandidates.map((candidate) => candidate.score)
  );
  const sufficient = sufficientCandidates
    .filter((candidate) => candidate.score >= strongestScore - 0.05)
    .sort(
      (left, right) =>
        left.chars - right.chars || right.score - left.score
    );

  if (sufficient[0]) {
    sufficient[0].selected = true;
    return [sufficient[0]];
  }

  const combinable = [...candidates]
    .filter((candidate) => candidate.score >= 0.35)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2);
  const combinedChars = combinable.reduce(
    (total, candidate) => total + candidate.chars,
    0
  );
  if (
    combinable.length === 2 &&
    combinable[0].score + combinable[1].score >= 0.9 &&
    combinedChars <= maxExpansionChars
  ) {
    for (const candidate of combinable) candidate.selected = true;
    return combinable;
  }

  for (const candidate of candidates) {
    candidate.rejectedReason = "below-context-sufficiency-threshold";
  }
  return [];
}

function buildSafePromptContext(input: {
  baseContext: AdvisorPromptContext;
  logicalQuestionUnit: LogicalQuestionUnit;
  meetingContext: MeetingContextState;
  activeMeetingTask?: ActiveMeetingTask;
  selectedCandidates: ContextScopeCandidate[];
  preserveTaskProcedure: boolean;
}): AdvisorPromptContext {
  const latestTurn = resolveLatestTurn(
    input.meetingContext,
    input.logicalQuestionUnit
  );

  return {
    ...input.baseContext,
    transcript: input.selectedCandidates
      .map((candidate) => candidate.text)
      .join("\n\n"),
    screenContext: "",
    interviewSessionBrief: undefined,
    interviewSessionContext: undefined,
    activeScreenTask: undefined,
    activeInterviewTask: undefined,
    activeMeetingTask: sanitizeActiveMeetingTask(input.activeMeetingTask),
    rollingSummary: "",
    userProfileContext: "",
    glossaryText: "",
    memoryContext: undefined,
    interviewPlaybook: input.preserveTaskProcedure
      ? input.baseContext.interviewPlaybook
      : undefined,
    playbookPhaseDecision: input.preserveTaskProcedure
      ? input.baseContext.playbookPhaseDecision
      : undefined,
    factAnchorDecision: undefined,
    projectBindingDecision: undefined,
    openingRoute: undefined,
    confirmedMeFacts: undefined,
    latestTurn,
  };
}

function sanitizeActiveMeetingTask(
  task: ActiveMeetingTask | undefined
): ActiveMeetingTask | undefined {
  if (!task) return undefined;

  return {
    ...task,
    parent: {
      ...task.parent,
      topic: "",
      playbook: task.parent.playbook
        ? { ...task.parent.playbook }
        : undefined,
      phaseProgress: { ...task.parent.phaseProgress },
      projectBinding: undefined,
      supportedFactAnchors: [],
      latestUsefulAnswer: undefined,
      previousUsefulAnswer: undefined,
      whiteboardArtifact: undefined,
      canonicalQuestionSourceTurnIds:
        task.parent.canonicalQuestionSourceTurnIds
          ? [...task.parent.canonicalQuestionSourceTurnIds]
          : undefined,
      parentContextHandoff: undefined,
    },
    child: undefined,
    screen: task.screen
      ? {
          ...task.screen,
          question: undefined,
          latestScreenAnswer: undefined,
          content: undefined,
        }
      : undefined,
    divergence: task.divergence ? { ...task.divergence } : undefined,
  };
}

function buildResult(input: {
  action: ContextScopeResponseAction;
  mode: ContextScopeMode;
  promptContext: AdvisorPromptContext;
  logicalQuestionUnit: LogicalQuestionUnit;
  candidates: ContextScopeCandidate[];
  selectionReason: string;
  independentQuestionGuardApplied: boolean;
  budgets: ContextScopeSelectionBudgets;
}): ContextScopeResponseActionResult {
  const selected = input.candidates.filter((candidate) => candidate.selected);

  return {
    action: input.action,
    contextScopeMode: input.mode,
    promptContext: input.promptContext,
    logicalQuestionUnitId: input.logicalQuestionUnit.id,
    logicalQuestionUnitRevision: input.logicalQuestionUnit.revision,
    candidates: input.candidates,
    selectedKinds: selected.map((candidate) => candidate.kind),
    selectedTurnIds: uniqueStrings(
      selected.flatMap((candidate) => candidate.turnIds)
    ),
    selectedChars: selected.reduce(
      (total, candidate) => total + candidate.chars,
      0
    ),
    selectedScores: Object.fromEntries(
      selected.map((candidate) => [candidate.kind, candidate.score])
    ),
    selectionReason: input.selectionReason,
    independentQuestionGuardApplied:
      input.independentQuestionGuardApplied,
    budgets: input.budgets,
  };
}

function resolveQuestionRelation(
  input: ContextScopeCompositionInput
): ContextScopeQuestionRelation {
  if (input.questionRelation) return input.questionRelation;

  const unit = input.logicalQuestionUnit;
  if (
    unit.compositionReasons.some((reason) => reason.includes("referential")) ||
    hasReferentialEvidence(unit.normalizedText)
  ) {
    return "referential-follow-up";
  }

  if (
    [
      "explicit-task-switch",
      "committed-parent-boundary",
      "authoritative-correction-boundary",
    ].includes(unit.boundaryReason) ||
    (unit.boundaryReason === "independent-current-turn" &&
      hasIndependentQuestionEvidence(unit.normalizedText))
  ) {
    return "independent-new-question";
  }

  return "unknown";
}

function resolveActiveMeetingTask(input: ContextScopeCompositionInput) {
  return (
    input.activeMeetingTask ??
    input.meetingContext.activeMeetingTask ??
    input.baseContext.activeMeetingTask
  );
}

function resolveBudgets(
  budgets: Partial<ContextScopeSelectionBudgets> | undefined
): ContextScopeSelectionBudgets {
  return {
    maxRecentThemTurns: clampInteger(
      budgets?.maxRecentThemTurns,
      1,
      CONTEXT_SCOPE_MAX_RECENT_THEM_TURNS,
      CONTEXT_SCOPE_MAX_RECENT_THEM_TURNS
    ),
    maxExpansionChars: clampInteger(
      budgets?.maxExpansionChars,
      1,
      CONTEXT_SCOPE_MAX_EXPANSION_CHARS,
      CONTEXT_SCOPE_MAX_EXPANSION_CHARS
    ),
    maxCapsuleChars: clampInteger(
      budgets?.maxCapsuleChars,
      1,
      CONTEXT_SCOPE_MAX_CAPSULE_CHARS,
      CONTEXT_SCOPE_MAX_CAPSULE_CHARS
    ),
  };
}

function resolveLatestTurn(
  meetingContext: MeetingContextState,
  logicalQuestionUnit: LogicalQuestionUnit
): TranscriptTurn {
  const existing = meetingContext.transcriptTurns.find(
    (turn) => turn.id === logicalQuestionUnit.currentTurnId
  );
  if (existing) return { ...existing };

  const source =
    logicalQuestionUnit.sources.find(
      (item) => item.turnId === logicalQuestionUnit.currentTurnId
    ) ?? logicalQuestionUnit.sources[logicalQuestionUnit.sources.length - 1];

  return {
    id: logicalQuestionUnit.currentTurnId,
    speaker: "them",
    text: source?.text ?? logicalQuestionUnit.normalizedText,
    startedAt: source?.startedAt ?? logicalQuestionUnit.startedAt,
    endedAt: source?.endedAt ?? logicalQuestionUnit.updatedAt,
    isFinal: true,
    source: "system-audio",
  };
}

function isRelevantInterleavedMeTurn(
  turn: TranscriptTurn,
  selectedThemTurns: TranscriptTurn[],
  logicalQuestionUnit: LogicalQuestionUnit
) {
  if (turn.contextTier === "me_attempted_answer_long") return false;
  if (turn.contextPromptEligible === true) return true;

  const relatedTurnIds = new Set(turn.relatedTurnIds ?? []);
  return (
    logicalQuestionUnit.sourceTurnIds.some((id) => relatedTurnIds.has(id)) ||
    selectedThemTurns.some((candidate) => relatedTurnIds.has(candidate.id))
  );
}

function formatBoundedTurnWindow(
  turns: TranscriptTurn[],
  maxChars: number
) {
  const selectedLines: Array<{ turnId: string; line: string }> = [];
  let remaining = maxChars;

  for (const turn of [...turns].sort(compareTurns).reverse()) {
    const prefix = `${formatSpeaker(turn)}: `;
    const newlineChars = selectedLines.length > 0 ? 1 : 0;
    const available = remaining - newlineChars;
    if (available <= prefix.length) continue;
    const line = `${prefix}${normalizeText(turn.text)}`.slice(0, available);
    if (!line.trim()) continue;
    selectedLines.unshift({ turnId: turn.id, line });
    remaining -= line.length + newlineChars;
    if (remaining <= 0) break;
  }

  return {
    text: selectedLines.map((item) => item.line).join("\n"),
    turnIds: selectedLines.map((item) => item.turnId),
  };
}

function findTurnsById(
  meetingContext: MeetingContextState,
  turnIds: string[]
) {
  const wanted = new Set(turnIds);
  return meetingContext.transcriptTurns
    .filter((turn) => wanted.has(turn.id) && turn.isFinal)
    .sort(compareTurns);
}

function hasReferentialEvidence(text: string) {
  const normalized = normalizeText(text);
  return (
    /\b(?:that|this|it|those|these|same|continue|earlier|previous|back to|what about|how about|for that|from there)\b/i.test(
      normalized
    ) ||
    /(?:这个|那个|它|同样|继续|之前|回到|刚才|基于此)/.test(normalized)
  );
}

function hasChildReferenceEvidence(currentText: string, childText: string) {
  return (
    /\b(?:back to|earlier|previous|child|probe|retrieval|implementation|complexity)\b/i.test(
      currentText
    ) ||
    lexicalSimilarity(currentText, childText) >= 0.2
  );
}

function hasParentReferenceEvidence(text: string) {
  return (
    /\b(?:overall|end[- ]to[- ]end|system[- ]wide|architecture|scale|scalability|qps|throughput|latency|reliability|bottleneck|metrics?|data flow|api|storage)\b/i.test(
      text
    ) ||
    /(?:整体|全局|架构|扩展|吞吐|延迟|可靠性|瓶颈|指标|数据流|存储)/.test(
      text
    )
  );
}

function hasIndependentQuestionEvidence(text: string) {
  const normalized = normalizeText(text);
  if (hasReferentialEvidence(normalized)) return false;

  return (
    /\b(?:now|next|move on|another question|new question|let(?:'s| us))\b/i.test(
      normalized
    ) ||
    /\b(?:design|build|implement|explain|describe|tell me|what is|how would|how do|write)\b/i.test(
      normalized
    )
  );
}

function lexicalSimilarity(left: string, right: string) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(leftTokens.size * rightTokens.size);
}

function tokenize(text: string) {
  const normalized = normalizeText(text).toLowerCase();
  const latin =
    normalized.match(/[a-z0-9][a-z0-9_+#.-]*/g)?.filter(
      (token) => !STOP_WORDS.has(token)
    ) ?? [];
  const cjk = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const cjkBigrams = cjk.flatMap((chunk) =>
    Array.from({ length: Math.max(0, chunk.length - 1) }, (_, index) =>
      chunk.slice(index, index + 2)
    )
  );
  return new Set([...latin, ...cjkBigrams]);
}

function formatSpeaker(turn: TranscriptTurn) {
  return turn.speaker === "me" ? "Me (clarification)" : "Them";
}

function compareTurns(left: TranscriptTurn, right: TranscriptTurn) {
  return (
    left.startedAt - right.startedAt ||
    left.endedAt - right.endedAt ||
    left.id.localeCompare(right.id)
  );
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number) {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd();
}

function uniqueStrings(
  values: Array<string | undefined>
): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value!)));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "with",
  "would",
  "you",
]);
