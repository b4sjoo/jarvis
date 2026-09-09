import { buildMeetingAnswerSummary } from "./meeting-answer.js";
import type { ActiveMeetingTask } from "./active-meeting-task.js";
import type { StableAnswerRevision } from "./stable-answer.js";
import type {
  AdvisorGeneratedContinuityCapsule,
  AdvisorGeneratedContinuityEvidence,
  InterviewTaskRelation,
  MeetingResponseActionMode,
} from "./types.js";

const MAX_CAPSULE_SNIPPETS = 3;
const MAX_CAPSULE_CHARS = 520;
const MAX_HISTORY_CAPSULES = 4;
const MAX_SELECTED_CAPSULES = 2;
const MAX_SELECTED_CHARS = 900;

export interface BoundedGeneratedContinuityOwner {
  sessionId?: StableAnswerRevision["sessionId"];
  runtimeEpoch?: StableAnswerRevision["runtimeEpoch"];
  parentTaskId: string;
  childTaskId?: string;
}

export interface BoundedGeneratedContinuityState {
  owner?: Omit<BoundedGeneratedContinuityOwner, "childTaskId">;
  latestUsefulAnswer?: string;
  previousUsefulAnswer?: string;
  child?: { childTaskId: string; compactSummary: string };
  recentCapsules: AdvisorGeneratedContinuityCapsule[];
}

/** OUTPUT continuity only; callers retain all prompt-read authorization. */
export interface BoundedGeneratedContinuityRead {
  source: "generated-continuity";
  latestUsefulAnswer?: string;
  previousUsefulAnswer?: string;
  childCompactSummary?: string;
  recentCapsules: AdvisorGeneratedContinuityCapsule[];
}

/** Prepares an after-state; only the existing publication owner installs it. */
export function prepareBoundedGeneratedContinuity(input: {
  state: BoundedGeneratedContinuityState;
  stable: StableAnswerRevision;
  currentOwner?: BoundedGeneratedContinuityOwner;
  parentRevision: number;
  parentSummaryAllowed: boolean;
  parentSummary?: string;
  childSummary?: string;
  artifactOnly?: boolean;
}): BoundedGeneratedContinuityState {
  const { stable, currentOwner } = input;
  if (input.artifactOnly || !currentOwner) return input.state;
  const answerOwner = stable.sections.answer.owner;
  if (
    stable.sessionId !== currentOwner.sessionId ||
    stable.runtimeEpoch !== currentOwner.runtimeEpoch ||
    stable.taskId !== currentOwner.parentTaskId ||
    !answerOwner ||
    answerOwner.parentId !== currentOwner.parentTaskId ||
    (answerOwner.kind === "active-child"
      ? answerOwner.childId !== currentOwner.childTaskId
      : currentOwner.childTaskId !== undefined)
  ) {
    return input.state;
  }

  const state = input.state.owner && !sameContinuityParent(input.state.owner, currentOwner)
    ? { recentCapsules: [] } as BoundedGeneratedContinuityState
    : input.state;

  const summary = input.parentSummaryAllowed && !currentOwner.childTaskId
    ? (input.parentSummary ?? (stable.suggestion.meetingAnswer
        ? buildMeetingAnswerSummary(stable.suggestion.meetingAnswer).text
        : "")).trim().slice(0, 1000)
    : "";
  const childSummary = input.childSummary?.trim().slice(0, 800);
  const capsule = createAdvisorGeneratedContinuityCapsule({
    stable,
    parentRevision: input.parentRevision,
    childTaskId: currentOwner.childTaskId,
  });
  return {
    owner: {
      sessionId: currentOwner.sessionId,
      runtimeEpoch: currentOwner.runtimeEpoch,
      parentTaskId: currentOwner.parentTaskId,
    },
    latestUsefulAnswer: summary || state.latestUsefulAnswer,
    previousUsefulAnswer:
      summary && state.latestUsefulAnswer && summary !== state.latestUsefulAnswer
        ? state.latestUsefulAnswer
        : state.previousUsefulAnswer,
    child: currentOwner.childTaskId
      ? childSummary
        ? { childTaskId: currentOwner.childTaskId, compactSummary: childSummary }
        : state.child?.childTaskId === currentOwner.childTaskId
          ? { ...state.child }
          : undefined
      : undefined,
    recentCapsules: appendAdvisorGeneratedContinuityCapsule({
      history: state.recentCapsules,
      capsule,
    }).map(cloneCapsule),
  };
}

export function readBoundedGeneratedContinuity(input: {
  state: BoundedGeneratedContinuityState;
  currentOwner?: BoundedGeneratedContinuityOwner;
}): BoundedGeneratedContinuityRead {
  const { state, currentOwner } = input;
  if (!state.owner || !currentOwner || !sameContinuityParent(state.owner, currentOwner)) {
    return { source: "generated-continuity", recentCapsules: [] };
  }
  return {
    source: "generated-continuity",
    latestUsefulAnswer: state.latestUsefulAnswer,
    previousUsefulAnswer: state.previousUsefulAnswer,
    childCompactSummary: currentOwner.childTaskId &&
      state.child?.childTaskId === currentOwner.childTaskId
        ? state.child.compactSummary
        : undefined,
    // The existing recent-history gate intentionally spans children of this parent.
    recentCapsules: state.recentCapsules
      .filter((capsule) => capsule.parentTaskId === currentOwner.parentTaskId)
      .map(cloneCapsule),
  };
}

/** The caller chooses the lane using existing lifecycle authority. */
export function clearBoundedGeneratedContinuity(input: {
  state: BoundedGeneratedContinuityState;
  scope: "recent" | "child" | "branch";
}): BoundedGeneratedContinuityState {
  if (input.scope === "branch") return { recentCapsules: [] };
  return {
    ...input.state,
    owner: input.state.owner ? { ...input.state.owner } : undefined,
    child: input.scope === "child" || !input.state.child
      ? undefined
      : { ...input.state.child },
    recentCapsules: input.scope === "recent"
      ? []
      : input.state.recentCapsules.map(cloneCapsule),
  };
}

function sameContinuityParent(
  left: Omit<BoundedGeneratedContinuityOwner, "childTaskId">,
  right: BoundedGeneratedContinuityOwner
) {
  return left.sessionId === right.sessionId &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.parentTaskId === right.parentTaskId;
}

export function clearBoundedGeneratedSummaries(
  state: BoundedGeneratedContinuityState
): BoundedGeneratedContinuityState {
  return {
    owner: state.owner ? { ...state.owner } : undefined,
    recentCapsules: state.recentCapsules.map(cloneCapsule),
  };
}

export function projectBoundedGeneratedContinuityForTask(input: {
  state: BoundedGeneratedContinuityState;
  task?: ActiveMeetingTask;
  sessionId: string;
  runtimeEpoch: number;
}): ActiveMeetingTask | undefined {
  const task = input.task;
  if (!task) return undefined;
  const generated = readBoundedGeneratedContinuity({
    state: input.state,
    currentOwner: {
      sessionId: input.sessionId,
      runtimeEpoch: input.runtimeEpoch,
      parentTaskId: task.parent.id,
      childTaskId: task.child?.id,
    },
  });
  return {
    ...task,
    parent: {
      ...task.parent,
      latestUsefulAnswer: generated.latestUsefulAnswer,
      previousUsefulAnswer: generated.previousUsefulAnswer,
    },
    child: task.child ? { ...task.child, compactSummary: generated.childCompactSummary } : undefined,
  };
}

const DECISION_MARKERS = [
  /\btrade[- ]?offs?\b/i,
  /\b(?:option|alternative|approach|decision|choice|recommend|prefer)\b/i,
  /\b(?:versus|vs\.?|rather than|instead of|because|therefore)\b/i,
  /\b(?:latency|consistency|availability|throughput|cost|complexity)\b/i,
  /权衡|取舍|方案|选项|选择|决定|建议|相比|因为|因此/,
];

const DEICTIC_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern:
      /\b(?:this|that|the)\s+(?:trade[- ]?off|option|alternative|approach|decision|choice|component|part|point|design)\b/i,
    label: "named-deictic-reference",
  },
  {
    pattern:
      /\b(?:explain|elaborate|expand|clarify|compare|detail)\b[^.!?]{0,80}\b(?:that|this|it)\b/i,
    label: "deictic-elaboration-request",
  },
  {
    pattern:
      /\b(?:former|latter|same approach|same option|earlier point|previous point|previous option)\b/i,
    label: "relative-option-reference",
  },
  {
    pattern:
      /(?:这个|那个|上述|刚才的|前面的)(?:权衡|取舍|方案|选项|方法|决定|设计|部分|观点)/,
    label: "named-deictic-reference-zh",
  },
  {
    pattern:
      /(?:进一步|详细)(?:解释|展开|说明)[^。！？]{0,40}(?:这个|那个|它)/,
    label: "deictic-elaboration-request-zh",
  },
];

export type BoundedRecentHistoryDecisionReason =
  | "authorized-explicit-enhance"
  | "authorized-deictic-followup"
  | "missing-active-parent"
  | "missing-generated-continuity"
  | "manual-correction-current-only"
  | "manual-narrow-current-only"
  | "transient-personal-status"
  | "new-parent-boundary"
  | "source-conflict"
  | "parent-mismatch"
  | "not-deictic"
  | "relation-not-compatible";

export interface BoundedRecentHistoryDecision {
  authorized: boolean;
  contextReadScope: "current-only" | "bounded-recent-history";
  reason: BoundedRecentHistoryDecisionReason;
  parentTaskId?: string;
  deicticEvidence: string[];
  candidateCount: number;
  selectedCapsules: AdvisorGeneratedContinuityCapsule[];
  selectedChars: number;
  explicitEnhance: boolean;
}

export function createAdvisorGeneratedContinuityCapsule(input: {
  stable: StableAnswerRevision;
  parentRevision: number;
  childTaskId?: string;
}): AdvisorGeneratedContinuityCapsule | undefined {
  const parentTaskId = cleanText(input.stable.taskId ?? undefined);
  if (!parentTaskId) return undefined;

  const answer = input.stable.suggestion.meetingAnswer;
  const sourceText = [answer?.sections.answer, answer?.sections.approach]
    .map(cleanText)
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const text = summarizeGeneratedContinuity(sourceText);
  if (!text) return undefined;

  return {
    id: [
      "generated_continuity",
      parentTaskId,
      input.stable.revision,
      input.stable.suggestion.id,
    ].join("_"),
    parentTaskId,
    parentRevision: input.parentRevision,
    childTaskId: cleanText(input.childTaskId),
    logicalQuestionUnitId:
      cleanText(input.stable.logicalQuestionUnitId ?? undefined),
    logicalQuestionRevision:
      input.stable.logicalQuestionRevision ?? undefined,
    answerRevision: input.stable.revision,
    sourceSuggestionId: input.stable.suggestion.id,
    sourceTraceId: cleanText(input.stable.suggestion.sourceTraceId),
    text,
    source: "generated-continuity",
    createdAt: input.stable.committedAt,
  };
}

export function appendAdvisorGeneratedContinuityCapsule(input: {
  history: AdvisorGeneratedContinuityCapsule[];
  capsule?: AdvisorGeneratedContinuityCapsule;
  reset?: boolean;
}): AdvisorGeneratedContinuityCapsule[] {
  const base = input.reset ? [] : input.history;
  if (!input.capsule) return base.slice(-MAX_HISTORY_CAPSULES);

  return [
    ...base.filter(
      (candidate) =>
        candidate.parentTaskId === input.capsule?.parentTaskId &&
        candidate.id !== input.capsule?.id
    ),
    cloneCapsule(input.capsule),
  ].slice(-MAX_HISTORY_CAPSULES);
}

export function decideBoundedRecentHistoryRead(input: {
  questionText: string;
  activeParentId?: string;
  relation: InterviewTaskRelation;
  relationUnresolved?: boolean;
  responseAction?: MeetingResponseActionMode;
  hasManualCorrection?: boolean;
  transientPersonalStatus?: boolean;
  sourceConflict?: boolean;
  capsules: AdvisorGeneratedContinuityCapsule[];
}): BoundedRecentHistoryDecision {
  const explicitEnhance = input.responseAction === "enhance-context";
  const deicticEvidence = detectDeicticContinuityEvidence(
    input.questionText
  );
  const denied = (
    reason: BoundedRecentHistoryDecisionReason,
    candidateCount = 0
  ): BoundedRecentHistoryDecision => ({
    authorized: false,
    contextReadScope: "current-only",
    reason,
    parentTaskId: input.activeParentId,
    deicticEvidence,
    candidateCount,
    selectedCapsules: [],
    selectedChars: 0,
    explicitEnhance,
  });

  if (!input.activeParentId) return denied("missing-active-parent");
  if (input.hasManualCorrection) {
    return denied("manual-correction-current-only");
  }
  if (input.responseAction === "narrow-context") {
    return denied("manual-narrow-current-only");
  }
  if (input.transientPersonalStatus) {
    return denied("transient-personal-status");
  }
  if (input.sourceConflict) return denied("source-conflict");
  if (input.relation === "new-parent") {
    return denied("new-parent-boundary");
  }

  const parentCapsules = input.capsules.filter(
    (capsule) => capsule.parentTaskId === input.activeParentId
  );
  if (!input.capsules.length) {
    return denied("missing-generated-continuity");
  }
  if (!parentCapsules.length) {
    return denied("parent-mismatch", input.capsules.length);
  }
  if (!explicitEnhance && !deicticEvidence.length) {
    return denied("not-deictic", parentCapsules.length);
  }
  const relationCompatible =
    input.relationUnresolved ||
    input.relation === "followup-parent" ||
    input.relation === "child-probe" ||
    input.relation === "resume-parent";
  if (!explicitEnhance && !relationCompatible) {
    return denied("relation-not-compatible", parentCapsules.length);
  }

  const selectedCapsules = selectBoundedCapsules(parentCapsules);
  if (!selectedCapsules.length) {
    return denied("missing-generated-continuity", parentCapsules.length);
  }
  return {
    authorized: true,
    contextReadScope: "bounded-recent-history",
    reason: explicitEnhance
      ? "authorized-explicit-enhance"
      : "authorized-deictic-followup",
    parentTaskId: input.activeParentId,
    deicticEvidence,
    candidateCount: parentCapsules.length,
    selectedCapsules,
    selectedChars: selectedCapsules.reduce(
      (total, capsule) => total + capsule.text.length,
      0
    ),
    explicitEnhance,
  };
}

export function toAdvisorGeneratedContinuityEvidence(
  decision: BoundedRecentHistoryDecision
): AdvisorGeneratedContinuityEvidence | undefined {
  if (
    !decision.authorized ||
    !decision.parentTaskId ||
    !decision.selectedCapsules.length
  ) {
    return undefined;
  }
  return {
    contextReadScope: "bounded-recent-history",
    decisionReason: decision.reason,
    parentTaskId: decision.parentTaskId,
    deicticEvidence: [...decision.deicticEvidence],
    capsules: decision.selectedCapsules.map(cloneCapsule),
  };
}

export function formatBoundedRecentHistoryForTrace(
  decision: BoundedRecentHistoryDecision
): Record<string, unknown> {
  return {
    boundedRecentHistoryDecision: decision.authorized
      ? "authorized"
      : "denied",
    boundedRecentHistoryReason: decision.reason,
    boundedRecentHistoryContextReadScope: decision.contextReadScope,
    boundedRecentHistoryParentTaskId: decision.parentTaskId,
    boundedRecentHistoryDeicticEvidence: decision.deicticEvidence,
    boundedRecentHistoryCandidateCount: decision.candidateCount,
    boundedRecentHistorySelectedCount:
      decision.selectedCapsules.length,
    boundedRecentHistorySelectedChars: decision.selectedChars,
    boundedRecentHistorySourceTraceCount: new Set(
      decision.selectedCapsules
        .map((capsule) => capsule.sourceTraceId)
        .filter(Boolean)
    ).size,
    boundedRecentHistorySourceSuggestionIds:
      decision.selectedCapsules.map(
        (capsule) => capsule.sourceSuggestionId
      ),
    boundedRecentHistoryExplicitEnhance: decision.explicitEnhance,
    boundedRecentHistoryAuthority: "generated-continuity-only",
    boundedRecentHistoryFactAuthority: false,
    boundedRecentHistoryTaskMutationAuthority: false,
    boundedRecentHistoryArtifactMutationAuthority: false,
  };
}

function summarizeGeneratedContinuity(value: string) {
  const segments = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*]\s+/gm, "")
    .split(/\n+|(?<=[.!?。！？])\s+/)
    .map((segment) =>
      cleanText(
        segment
          .replace(/[*_`>#]/g, "")
          .replace(/^(?:answer|approach)\s*:\s*/i, "")
      )
    )
    .filter((segment): segment is string => Boolean(segment))
    .filter((segment) => segment.length >= 12);
  if (!segments.length) return undefined;

  const ranked = segments
    .map((segment, index) => ({
      segment,
      index,
      score: DECISION_MARKERS.reduce(
        (score, pattern) => score + (pattern.test(segment) ? 2 : 0),
        0
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked
    .slice(0, MAX_CAPSULE_SNIPPETS)
    .sort((left, right) => left.index - right.index)
    .map(({ segment }) => segment);
  return selected.join("\n").slice(0, MAX_CAPSULE_CHARS);
}

function detectDeicticContinuityEvidence(value: string) {
  const text = cleanText(value) ?? "";
  return DEICTIC_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ label }) => label
  );
}

function selectBoundedCapsules(
  capsules: AdvisorGeneratedContinuityCapsule[]
) {
  const selected: AdvisorGeneratedContinuityCapsule[] = [];
  let selectedChars = 0;
  for (const capsule of [...capsules].reverse()) {
    if (selected.length >= MAX_SELECTED_CAPSULES) break;
    if (
      selected.length > 0 &&
      selectedChars + capsule.text.length > MAX_SELECTED_CHARS
    ) {
      continue;
    }
    selected.push(cloneCapsule(capsule));
    selectedChars += capsule.text.length;
  }
  return selected.reverse();
}

function cloneCapsule(
  capsule: AdvisorGeneratedContinuityCapsule
): AdvisorGeneratedContinuityCapsule {
  return { ...capsule };
}

function cleanText(value: string | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}
