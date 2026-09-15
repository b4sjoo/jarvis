import {
  loadMemoryEntriesForSnapshot,
  markMemoryEntriesUsedBatch,
} from "@/lib/database/memory.action";
import type {
  MemoryEntry,
  MemoryAskFrame,
  MemoryGeneralScopePath,
  MemoryInterviewType,
  MemoryOverlaySelectionSummary,
  MemoryPolicySnapshot,
  MemoryQuestionType,
  MemoryRejectReason,
  MemoryRejectSummary,
  MemoryRetrievalRequest,
  MemoryRetrievalPolicy,
  MemoryRetrievalPerformance,
  MemoryRetrievalResult,
  MemoryTopicDomain,
  MemoryUseCase,
  RetrievedMemoryEntry,
} from "./types";
import {
  getSharedMemoryRetrievalRuntime,
  type MemoryUsageFlushResult,
} from "./retrieval-runtime";
import { isMemoryProjectAnchorCompatible } from "./project-anchor.js";
import {
  gateDiagramOverlayEntriesByDomain,
  isDiagramOverlayMemoryEntry,
} from "./diagram-overlay.js";
import {
  classifyRuntimeMemoryRole,
  resolveRetrievedMemoryRole,
} from "./runtime-role.js";
import {
  resolveMemoryInterviewFamilies,
  resolveMemoryInterviewFamilyGateDecision,
} from "./interview-family.js";
import { createMemoryInterviewFamilyResolutionRecorder } from "./interview-family-telemetry.js";
import { formatMemoryContext } from "./context-format.js";
import {
  createGeneralMemoryEligibilityRecorder,
  resolveGeneralMemoryEligibility,
  resolveMemoryEligibilityQuery,
  resolveProjectScopedFactMemoryEligibility,
} from "./general-eligibility.js";
import { scoreCurrentQuestionRelevance } from "./current-question-ranking.js";
import { preparationMemoryPurpose } from "./preparation-purpose.js";
import {
  selectBehavioralStoryFamily,
  shouldAdmitBehavioralFamilyLinkedStory,
  summarizeBehavioralStoryFamilySelection,
} from "./behavioral-story-family.js";

const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_PER_ENTRY_MAX_CHARS = 1200;

const PRIORITY_BOOST: Record<MemoryEntry["priority"], number> = {
  low: 0,
  normal: 4,
  high: 12,
  pinned: 24,
};

export interface MemoryRetrievalRuntimeCallbacks {
  onUsageFlush?: (result: MemoryUsageFlushResult) => void;
}

export async function retrieveMemoryContext({
  preparationPurpose,
  sessionId,
  query,
  currentQuestionQuery,
  behavioralStoryQuery,
  preferredBehavioralStoryAnchors,
  diagramDomainQuery,
  diagramTopicDomain,
  useCase,
  projectId,
  interviewTypes,
  questionType,
  askFrame,
  topicDomain,
  projectAnchor,
  memoryPolicy,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
  perEntryMaxChars = DEFAULT_PER_ENTRY_MAX_CHARS,
}: MemoryRetrievalRequest,
callbacks: MemoryRetrievalRuntimeCallbacks = {}): Promise<MemoryRetrievalResult> {
  const totalStartedAt = monotonicNow();
  const runtime = getSharedMemoryRetrievalRuntime();
  const snapshot = await runtime.readSnapshot({
    sessionId,
    loader: loadMemoryEntriesForSnapshot,
  });
  const entries = snapshot.entries;
  const policyScoringStartedAt = monotonicNow();
  const rejectRecorder = createMemoryRejectRecorder();
  const overlayRejectRecorder = createMemoryRejectRecorder();
  const interviewFamilyRecorder =
    createMemoryInterviewFamilyResolutionRecorder();
  const generalEligibilityRecorder =
    createGeneralMemoryEligibilityRecorder();
  const eligibilityQueryDecision = resolveMemoryEligibilityQuery({
    retrievalQuery: query,
    currentQuestionQuery,
  });
  const generalScopePaths = new Map<string, MemoryGeneralScopePath>();
  const policySnapshot = buildMemoryPolicySnapshot({
    useCase,
    interviewTypes,
    questionType,
    askFrame,
    topicDomain,
    projectAnchor,
    memoryPolicy,
    maxEntries,
    maxChars,
    perEntryMaxChars,
    eligibilityQuerySource: eligibilityQueryDecision.source,
    eligibilityQueryChars: eligibilityQueryDecision.query.length,
    retrievalQueryChars: query.length,
  });
  const eligibleEntries: MemoryEntry[] = [];
  const effectiveDiagramDomainQuery =
    diagramDomainQuery === undefined ? query : diagramDomainQuery;
  const effectiveDiagramTopicDomain =
    diagramTopicDomain === undefined ? topicDomain : diagramTopicDomain;
  const diagramOverlayGate = gateDiagramOverlayEntriesByDomain(entries, {
    query: effectiveDiagramDomainQuery,
    questionType,
    topicDomain: effectiveDiagramTopicDomain,
  });
  const diagramOverlayRejections = new Map(
    diagramOverlayGate.rejected.map((item) => [item.entryId, item])
  );
  const behavioralFamilyProposal =
    questionType === "behavioral"
      ? selectBehavioralStoryFamily({
          entries,
          query:
            behavioralStoryQuery?.trim() ||
            currentQuestionQuery?.trim() ||
            query,
          questionType,
          preferredStoryAnchors: preferredBehavioralStoryAnchors,
        })
      : undefined;
  const behavioralFamilyCatalogIds = new Set(
    behavioralFamilyProposal?.candidates.flatMap((candidate) => [
      candidate.family.id,
      candidate.story.id,
    ]) ?? []
  );
  const selectedBehavioralStoryId =
    behavioralFamilyProposal?.selected?.story.id;
  let interviewFamilyEvaluationMs = 0;

  for (const entry of entries) {
    if (preparationPurpose && preparationMemoryPurpose(entry) !== preparationPurpose) {
      rejectRecorder.record("preparation-purpose-mismatch", entry);
      continue;
    }
    const diagramRejection = diagramOverlayRejections.get(entry.id);
    if (diagramRejection) {
      rejectRecorder.record(diagramRejection.reason, entry);
      overlayRejectRecorder.record(diagramRejection.reason, entry);
      continue;
    }
    const decision = getEntryEligibilityDecision(
      entry,
      useCase,
      interviewTypes,
      questionType,
      memoryPolicy,
      eligibilityQueryDecision.query,
      projectId,
      projectAnchor
    );
    if (decision.familyGateDecision) {
      interviewFamilyRecorder.record(entry.id, decision.familyGateDecision);
      interviewFamilyEvaluationMs += decision.familyGateEvaluationMs;
    }
    const behavioralLinkedStoryScopeOverride =
      shouldAdmitBehavioralFamilyLinkedStory({
        selectedStoryId: selectedBehavioralStoryId,
        entryId: entry.id,
        eligible: decision.eligible,
        rejectReason: decision.eligible ? undefined : decision.reason,
      });
    const generalEligibilityDecision = behavioralLinkedStoryScopeOverride
      ? {
          applies: true as const,
          eligible: true as const,
          scopePath: "explicit-reusable" as const,
          evidence: ["behavioral-family-linked-story"],
        }
      : decision.generalEligibilityDecision;
    if (generalEligibilityDecision) {
      generalEligibilityRecorder.record(
        entry.id,
        generalEligibilityDecision
      );
      if (
        (decision.eligible || behavioralLinkedStoryScopeOverride) &&
        generalEligibilityDecision.scopePath
      ) {
        generalScopePaths.set(
          entry.id,
          generalEligibilityDecision.scopePath
        );
      }
    }
    if (decision.eligible || behavioralLinkedStoryScopeOverride) {
      eligibleEntries.push(entry);
    } else {
      rejectRecorder.record(decision.reason, entry);
      if (isDiagramOverlayMemoryEntry(entry)) {
        overlayRejectRecorder.record(decision.reason, entry);
      }
    }
  }
  const queryTokens = tokenize(query);
  const currentQuestionTokens = tokenize(
    currentQuestionQuery?.trim() || query
  );
  const scoringContext = {
    useCase,
    projectId,
    questionType,
    askFrame,
    topicDomain,
    projectAnchor,
    query,
    currentQuestionQuery: currentQuestionQuery?.trim() || query,
  };
  const eligibleEntryIds = new Set(eligibleEntries.map((entry) => entry.id));
  const behavioralFamilySelection =
    behavioralFamilyProposal?.selected &&
    eligibleEntryIds.has(behavioralFamilyProposal.selected.family.id) &&
    eligibleEntryIds.has(behavioralFamilyProposal.selected.story.id)
      ? behavioralFamilyProposal
      : behavioralFamilyProposal
        ? {
            ...behavioralFamilyProposal,
            selected: undefined,
            runnerUp: undefined,
            margin: undefined,
            selectionSource: undefined,
            disposition: "no-valid-family" as const,
          }
        : undefined;
  const behavioralFamilySelectedIds = new Set(
    behavioralFamilySelection?.selected
      ? [
          behavioralFamilySelection.selected.family.id,
          behavioralFamilySelection.selected.story.id,
        ]
      : []
  );
  const taggedEntries: MemoryEntry[] = [];
  for (const entry of eligibleEntries) {
    if (
      behavioralFamilySelectedIds.has(entry.id) ||
      hasRequiredTaggedHints(entry, query)
    ) {
      taggedEntries.push(entry);
    } else {
      rejectRecorder.record("missing-required-tag-hint", entry);
      if (isDiagramOverlayMemoryEntry(entry)) {
        overlayRejectRecorder.record("missing-required-tag-hint", entry);
      }
    }
  }

  const alwaysEntries = taggedEntries
    .filter(
      (entry) =>
        !behavioralFamilyCatalogIds.has(entry.id) &&
        (entry.injectionMode === "always" || entry.priority === "pinned")
    )
    .map((entry) =>
      scoreMemoryEntry(
        entry,
        queryTokens,
        currentQuestionTokens,
        scoringContext,
        true
      )
    )
    .map((item) => appendGeneralScopeReason(item, generalScopePaths));
  const scoredRetrievalEntries = taggedEntries
    .filter(
      (entry) =>
        !behavioralFamilyCatalogIds.has(entry.id) &&
        !(
          questionType === "behavioral" && entry.type === "personal_story"
        ) &&
        entry.injectionMode === "retrieval" &&
        entry.priority !== "pinned"
    )
    .map((entry) =>
      scoreMemoryEntry(
        entry,
        queryTokens,
        currentQuestionTokens,
        scoringContext,
        false
      )
    )
    .map((item) => appendGeneralScopeReason(item, generalScopePaths));
  const retrievalEntries = scoredRetrievalEntries
    .filter((item) => {
      const matched = hasRetrievalMatch(item);
      if (!matched) {
        rejectRecorder.record("no-retrieval-match", item.entry);
        if (isDiagramOverlayMemoryEntry(item.entry)) {
          overlayRejectRecorder.record("no-retrieval-match", item.entry);
        }
      }
      return matched;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, memoryPolicy?.maxEntries ?? maxEntries);

  const behavioralFamilyEntries = behavioralFamilySelection?.selected
    ? [
        behavioralFamilySelection.selected.story,
        behavioralFamilySelection.selected.family,
      ].map((entry) => {
        const scored = scoreMemoryEntry(
          entry,
          queryTokens,
          currentQuestionTokens,
          scoringContext,
          false
        );
        return appendGeneralScopeReason(
          {
            ...scored,
            matchReason: [
              ...scored.matchReason,
              entry.id === behavioralFamilySelection.selected!.story.id
                ? `behavioral-family-story:${behavioralFamilySelection.selected!.family.id}`
                : "behavioral-family:selected",
            ],
          },
          generalScopePaths
        );
      })
    : [];
  const ordinaryEntries = dedupeRetrievedEntries([
    ...alwaysEntries,
    ...retrievalEntries,
  ])
    .filter(
      (entry) =>
        !behavioralFamilyCatalogIds.has(entry.entry.id) &&
        !(
          questionType === "behavioral" &&
          entry.entry.type === "personal_story"
        )
    )
    .sort((left, right) => right.score - left.score);
  const ranked = [...behavioralFamilyEntries, ...ordinaryEntries];
  const selected = preparationPurpose
    ? ranked.slice(0, memoryPolicy?.maxEntries ?? maxEntries)
    : ranked;
  if (preparationPurpose) {
    for (const item of ranked.slice(selected.length)) {
      rejectRecorder.record("budget-truncated", item.entry);
    }
  }
  const policyScoringMs = elapsedMs(policyScoringStartedAt);
  const budgetFormattingStartedAt = monotonicNow();
  const budgeted = applyMemoryBudget(
    selected,
    memoryPolicy?.maxChars ?? maxChars,
    memoryPolicy?.perEntryMaxChars ?? perEntryMaxChars
  );
  for (const item of budgeted.omittedEntries) {
    rejectRecorder.record("budget-truncated", item.entry);
    if (isDiagramOverlayMemoryEntry(item.entry)) {
      overlayRejectRecorder.record("budget-truncated", item.entry);
    }
  }

  const contextText = formatMemoryContext(budgeted.entries);
  const budgetFormattingMs = elapsedMs(budgetFormattingStartedAt);
  const usageEnqueue = budgeted.entries.length
    ? runtime.enqueueUsage({
        entryIds: budgeted.entries.map((entry) => entry.entry.id),
        writer: markMemoryEntriesUsedBatch,
        onFlush: callbacks.onUsageFlush,
      })
    : {
        addedEntryCount: 0,
        queueDepth: runtime.getUsageQueueDepth(),
        enqueueMs: 0,
        lastFlush: runtime.getLastUsageFlush(),
      };

  const performance: MemoryRetrievalPerformance = {
    totalMs: elapsedMs(totalStartedAt),
    cacheState: snapshot.telemetry.cacheState,
    cacheHit: snapshot.telemetry.cacheHit,
    cacheLookupMs: snapshot.telemetry.cacheLookupMs,
    snapshotVersion: snapshot.telemetry.snapshotVersion,
    snapshotGeneration: snapshot.telemetry.snapshotGeneration,
    snapshotAgeMs: snapshot.telemetry.snapshotAgeMs,
    snapshotSessionId: snapshot.telemetry.snapshotSessionId,
    authorityRevision: snapshot.telemetry.authorityRevision,
    invalidationKind: snapshot.telemetry.invalidationKind,
    invalidationReason: snapshot.telemetry.invalidationReason,
    invalidationPreviousSnapshotVersion:
      snapshot.telemetry.invalidationPreviousSnapshotVersion,
    invalidationNewSnapshotVersion:
      snapshot.telemetry.invalidationNewSnapshotVersion,
    invalidationToFirstReadMs:
      snapshot.telemetry.invalidationToFirstReadMs,
    invalidationFirstRead: snapshot.telemetry.invalidationFirstRead,
    hardInvalidationDisposition:
      snapshot.telemetry.hardInvalidationDisposition,
    hardInvalidationAffectedEntryIds:
      snapshot.telemetry.hardInvalidationAffectedEntryIds,
    hardInvalidationTargetsExcluded:
      snapshot.telemetry.hardInvalidationTargetsExcluded,
    hardInvalidationStaleSnapshotServed:
      snapshot.telemetry.hardInvalidationStaleSnapshotServed,
    databaseAcquireMs: snapshot.telemetry.databaseAcquireMs,
    databaseReadMs: snapshot.telemetry.databaseReadMs,
    rowMappingMs: snapshot.telemetry.rowMappingMs,
    persistedInterviewFamiliesExplicitCount:
      snapshot.telemetry.persistedInterviewFamiliesExplicitCount,
    persistedInterviewFamiliesMissingCount:
      snapshot.telemetry.persistedInterviewFamiliesMissingCount,
    persistedInterviewFamiliesMalformedCount:
      snapshot.telemetry.persistedInterviewFamiliesMalformedCount,
    policyScoringMs,
    budgetFormattingMs,
    usageEnqueueMs: usageEnqueue.enqueueMs,
    usageBatchId: usageEnqueue.batchId,
    usageAddedEntryCount: usageEnqueue.addedEntryCount,
    usageQueueDepth: usageEnqueue.queueDepth,
    lastUsageFlushMs: usageEnqueue.lastFlush?.durationMs,
    lastUsageFlushEntryCount: usageEnqueue.lastFlush?.entryCount,
    lastUsageFlushSuccess: usageEnqueue.lastFlush?.success,
    degradedReason: snapshot.telemetry.degradedReason,
  };
  const interviewFamilyResolution = interviewFamilyRecorder.summary(
    budgeted.entries.map((item) => item.entry.id),
    interviewFamilyEvaluationMs
  );

  return {
    entries: budgeted.entries,
    contextText,
    totalChars: budgeted.totalChars,
    candidateCount: entries.length,
    eligibleCount: eligibleEntries.length,
    rejectedCount: rejectRecorder.total(),
    rejectSummary: rejectRecorder.summary(),
    generalEligibility: generalEligibilityRecorder.summary(),
    interviewFamilyResolution,
    overlaySelection: buildMemoryOverlaySelectionSummary(
      budgeted.entries,
      overlayRejectRecorder.summary(),
      diagramOverlayGate
    ),
    behavioralStoryFamilySelection:
      summarizeBehavioralStoryFamilySelection(behavioralFamilySelection),
    policySnapshot,
    performance,
  };
}

export async function prewarmMemoryContextSnapshot(sessionId?: string) {
  return getSharedMemoryRetrievalRuntime().prewarmSnapshot({
    sessionId,
    loader: loadMemoryEntriesForSnapshot,
  });
}

export async function flushMemoryContextUsage() {
  return getSharedMemoryRetrievalRuntime().flushUsage();
}

export function formatMemoryRetrievalPerformanceForTrace(
  performance: MemoryRetrievalPerformance | undefined
) {
  if (!performance) return {};
  return {
    memoryTotalMs: performance.totalMs,
    memoryCacheState: performance.cacheState,
    memoryCacheHit: performance.cacheHit,
    memoryCacheLookupMs: performance.cacheLookupMs,
    memorySnapshotVersion: performance.snapshotVersion,
    memorySnapshotGeneration: performance.snapshotGeneration,
    memorySnapshotAgeMs: performance.snapshotAgeMs,
    memorySnapshotSessionId: performance.snapshotSessionId,
    memoryAuthorityRevision: performance.authorityRevision,
    memoryInvalidationKind: performance.invalidationKind,
    memoryInvalidationReason: performance.invalidationReason,
    memoryInvalidationPreviousSnapshotVersion:
      performance.invalidationPreviousSnapshotVersion,
    memoryInvalidationNewSnapshotVersion:
      performance.invalidationNewSnapshotVersion,
    memoryInvalidationToFirstReadMs:
      performance.invalidationToFirstReadMs,
    memoryInvalidationFirstRead: performance.invalidationFirstRead,
    memoryHardInvalidationDisposition:
      performance.hardInvalidationDisposition,
    memoryHardInvalidationAffectedEntryIds:
      performance.hardInvalidationAffectedEntryIds,
    memoryHardInvalidationTargetsExcluded:
      performance.hardInvalidationTargetsExcluded,
    memoryHardInvalidationStaleSnapshotServed:
      performance.hardInvalidationStaleSnapshotServed,
    memoryDatabaseAcquireMs: performance.databaseAcquireMs,
    memoryDatabaseReadMs: performance.databaseReadMs,
    memoryRowMappingMs: performance.rowMappingMs,
    memoryPersistedInterviewFamiliesExplicitCount:
      performance.persistedInterviewFamiliesExplicitCount,
    memoryPersistedInterviewFamiliesMissingCount:
      performance.persistedInterviewFamiliesMissingCount,
    memoryPersistedInterviewFamiliesMalformedCount:
      performance.persistedInterviewFamiliesMalformedCount,
    memoryPolicyScoringMs: performance.policyScoringMs,
    memoryBudgetFormattingMs: performance.budgetFormattingMs,
    memoryUsageEnqueueMs: performance.usageEnqueueMs,
    memoryUsageBatchId: performance.usageBatchId,
    memoryUsageAddedEntryCount: performance.usageAddedEntryCount,
    memoryUsageQueueDepth: performance.usageQueueDepth,
    memoryLastUsageFlushMs: performance.lastUsageFlushMs,
    memoryLastUsageFlushEntryCount:
      performance.lastUsageFlushEntryCount,
    memoryLastUsageFlushSuccess: performance.lastUsageFlushSuccess,
    memoryRetrievalDegradedReason: performance.degradedReason,
  };
}

export function formatMemorySelectionForTrace(result: MemoryRetrievalResult) {
  const rejectSummary = formatMemoryRejectSummaryForTrace(result.rejectSummary);
  const overlaySummary = formatOverlaySelectionForTrace(
    result.overlaySelection
  );
  const behavioralSummary = result.behavioralStoryFamilySelection
    ? [
        "Behavioral story family selection:",
        `- disposition: ${result.behavioralStoryFamilySelection.disposition}`,
        `- source: ${result.behavioralStoryFamilySelection.selectionSource ?? "none"}`,
        `- selected: ${result.behavioralStoryFamilySelection.selectedFamilyId ?? "none"} / ${result.behavioralStoryFamilySelection.selectedStoryId ?? "none"}`,
        `- runner-up: ${result.behavioralStoryFamilySelection.runnerUpFamilyId ?? "none"}`,
        `- margin: ${result.behavioralStoryFamilySelection.margin ?? "none"}`,
      ].join("\n")
    : "";
  if (!result.entries.length) {
    return [
      "No memory entries injected.",
      behavioralSummary,
      rejectSummary,
      overlaySummary,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const selected = result.entries
    .map((item, index) => {
      const entry = item.entry;
      const runtimeRole = resolveRetrievedMemoryRole(item);
      const familyDecision = resolveMemoryInterviewFamilies(entry);
      return [
        `${index + 1}. ${entry.title}`,
        `id=${entry.id}`,
        `type=${entry.type}`,
        `project=${entry.projectName || entry.projectId || entry.scope}`,
        `runtimeRole=${runtimeRole.role}`,
        `anchorEligible=${runtimeRole.anchorEligible}`,
        `anchorEligibilityReason=${runtimeRole.anchorEligibilityReason}`,
        `interviewFamilies=${familyDecision.families.join(",")}`,
        `interviewFamilyResolution=${familyDecision.resolutionReason}@v${familyDecision.resolutionVersion}`,
        `suppressedInterviewFamilies=${
          familyDecision.suppressedEvidence
            .map(
              (evidence) =>
                `${evidence.family}->${evidence.suppressedBySpecificFamily}`
            )
            .join(",") || "none"
        }`,
        `score=${item.score}`,
        `reason=${item.matchReason.join(", ") || "always"}`,
        "",
        item.injectedContent,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [behavioralSummary, selected, rejectSummary, overlaySummary]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function formatOverlaySelectionForTrace(
  overlaySelection: MemoryOverlaySelectionSummary | undefined
) {
  if (!overlaySelection) return "";

  return [
    "Memory overlay selection:",
    overlaySelection.selectedEntryIds.length
      ? `- selected: ${overlaySelection.selectedEntryIds.join(", ")}`
      : "- selected: none",
    `- rejectedCount: ${overlaySelection.rejectedCount}`,
    `- allowedFamilies: ${
      overlaySelection.domainGate?.allowedFamilies.join(", ") || "none"
    }`,
    `- domainEvidence: ${
      overlaySelection.domainGate?.evidence.join(", ") || "none"
    }`,
    ...(overlaySelection.domainGate?.blockedEntries ?? []).map(
      (item) =>
        `- domain-blocked ${item.entryId}: actual=${
          item.actualFamilies.join(", ") || "unknown"
        }`
    ),
    ...overlaySelection.rejectSummary.map(
      (item) =>
        `- ${item.reason}: ${item.count}${
          item.sampleEntryIds.length
            ? ` (${item.sampleEntryIds.join(", ")})`
            : ""
        }`
    ),
  ].join("\n");
}

function formatMemoryRejectSummaryForTrace(summary: MemoryRejectSummary[]) {
  if (!summary.length) return "Memory reject summary: none.";

  return [
    "Memory reject summary:",
    ...summary.map((item) =>
      [
        `- ${item.reason}: ${item.count}`,
        item.sampleEntryIds.length
          ? `  ids: ${item.sampleEntryIds.join(", ")}`
          : undefined,
        item.sampleTitles.length
          ? `  samples: ${item.sampleTitles.join(" | ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    ),
  ].join("\n");
}

function buildMemoryPolicySnapshot({
  useCase,
  interviewTypes,
  questionType,
  askFrame,
  topicDomain,
  projectAnchor,
  memoryPolicy,
  maxEntries,
  maxChars,
  perEntryMaxChars,
  eligibilityQuerySource,
  eligibilityQueryChars,
  retrievalQueryChars,
}: {
  useCase: MemoryUseCase;
  interviewTypes?: MemoryInterviewType[];
  questionType?: MemoryQuestionType;
  askFrame?: MemoryAskFrame;
  topicDomain?: MemoryTopicDomain;
  projectAnchor?: string;
  memoryPolicy?: MemoryRetrievalPolicy;
  maxEntries: number;
  maxChars: number;
  perEntryMaxChars: number;
  eligibilityQuerySource: "current-question" | "retrieval-query";
  eligibilityQueryChars: number;
  retrievalQueryChars: number;
}): MemoryPolicySnapshot {
  return {
    useCase,
    interviewTypes,
    questionType,
    askFrame,
    topicDomain,
    projectAnchor,
    memoryPolicyId: memoryPolicy?.id,
    allowedFamilies: memoryPolicy?.allowedFamilies,
    blockedFamilies: memoryPolicy?.blockedFamilies,
    strictProjectAnchor: memoryPolicy?.strictProjectAnchor,
    eligibilityQuerySource,
    eligibilityQueryChars,
    retrievalQueryChars,
    maxEntries: memoryPolicy?.maxEntries ?? maxEntries,
    maxChars: memoryPolicy?.maxChars ?? maxChars,
    perEntryMaxChars: memoryPolicy?.perEntryMaxChars ?? perEntryMaxChars,
  };
}

function createMemoryRejectRecorder() {
  const records: Array<{ reason: MemoryRejectReason; entry: MemoryEntry }> = [];

  return {
    record(reason: MemoryRejectReason, entry: MemoryEntry) {
      records.push({ reason, entry });
    },
    total() {
      return records.length;
    },
    summary(): MemoryRejectSummary[] {
      const grouped = new Map<MemoryRejectReason, MemoryEntry[]>();
      for (const record of records) {
        const entries = grouped.get(record.reason) ?? [];
        entries.push(record.entry);
        grouped.set(record.reason, entries);
      }

      return Array.from(grouped.entries())
        .map(([reason, entries]) => ({
          reason,
          count: entries.length,
          sampleEntryIds: entries.slice(0, 5).map((entry) => entry.id),
          sampleTitles: entries.slice(0, 5).map((entry) => entry.title),
        }))
        .sort((left, right) => right.count - left.count);
    },
  };
}

function getEntryEligibilityDecision(
  entry: MemoryEntry,
  useCase: MemoryUseCase,
  interviewTypes: MemoryInterviewType[] | undefined,
  questionType: MemoryQuestionType | undefined,
  memoryPolicy: MemoryRetrievalPolicy | undefined,
  query: string,
  projectId: string | undefined,
  projectAnchor: string | undefined
) {
  if (!entry.enabled) return { eligible: false as const, reason: "disabled" as const };
  if (entry.injectionMode === "manual_only" || entry.injectionMode === "never") {
    return { eligible: false as const, reason: "manual-or-never" as const };
  }
  if (entry.curationStatus !== "curated" && entry.curationStatus !== "verified") {
    return { eligible: false as const, reason: "uncurated" as const };
  }
  const useCaseMatched =
    entry.useCases.includes(useCase) ||
    entry.useCases.includes("meeting_assistant") ||
    entry.useCases.includes("general_chat");
  if (!useCaseMatched) {
    return { eligible: false as const, reason: "use-case-mismatch" as const };
  }
  const familyGateStartedAt = monotonicNow();
  const familyGateDecision = resolveMemoryInterviewFamilyGateDecision({
    entry,
    interviewTypes,
    questionType,
    memoryPolicy,
  });
  const familyGateEvaluationMs = elapsedMs(familyGateStartedAt);
  if (familyGateDecision.rejectReason) {
    return {
      eligible: false as const,
      reason: familyGateDecision.rejectReason,
      familyGateDecision,
      familyGateEvaluationMs,
    };
  }

  if (isProjectAnchorMismatch(entry, memoryPolicy?.strictProjectAnchor)) {
    return {
      eligible: false as const,
      reason: "project-anchor-mismatch" as const,
      familyGateDecision,
      familyGateEvaluationMs,
    };
  }

  const runtimeRole = classifyRuntimeMemoryRole(entry);
  const effectiveProjectAnchor =
    memoryPolicy?.strictProjectAnchor ?? projectAnchor;
  const projectFactEligibilityDecision =
    runtimeRole.role === "fact-evidence"
      ? resolveProjectScopedFactMemoryEligibility({
          entry,
          query,
          projectId,
          projectAnchor: effectiveProjectAnchor,
        })
      : undefined;
  const generalEligibilityDecision =
    projectFactEligibilityDecision?.applies
      ? projectFactEligibilityDecision
      : resolveGeneralMemoryEligibility({
          entry,
          familyDecision: familyGateDecision.resolution,
          query,
          useCase,
          projectId,
          projectAnchor: effectiveProjectAnchor,
        });
  if (!generalEligibilityDecision.eligible) {
    return {
      eligible: false as const,
      reason: generalEligibilityDecision.rejectReason!,
      familyGateDecision,
      familyGateEvaluationMs,
      generalEligibilityDecision,
    };
  }

  return {
    eligible: true as const,
    familyGateDecision,
    familyGateEvaluationMs,
    generalEligibilityDecision,
  };
}

function appendGeneralScopeReason(
  item: RetrievedMemoryEntry,
  scopePaths: Map<string, MemoryGeneralScopePath>
) {
  const scopePath = scopePaths.get(item.entry.id);
  return scopePath
    ? {
        ...item,
        matchReason: [`generalScope:${scopePath}`, ...item.matchReason],
      }
    : item;
}

interface MemoryScoringContext {
  useCase: MemoryUseCase;
  projectId?: string;
  questionType?: MemoryQuestionType;
  askFrame?: MemoryAskFrame;
  topicDomain?: MemoryTopicDomain;
  projectAnchor?: string;
  query: string;
  currentQuestionQuery: string;
}

function scoreMemoryEntry(
  entry: MemoryEntry,
  queryTokens: Set<string>,
  currentQuestionTokens: Set<string>,
  context: MemoryScoringContext,
  always: boolean
): RetrievedMemoryEntry {
  const matchReason: string[] = [];
  let score = PRIORITY_BOOST[entry.priority];

  if (always) {
    score += 30;
    matchReason.push("always");
  }

  if (entry.useCases.includes(context.useCase)) {
    score += 20;
    matchReason.push(`useCase:${context.useCase}`);
  }

  if (entry.scope === "global") {
    score += 2;
  }

  if (context.projectId && entry.projectId === context.projectId) {
    score += 20;
    matchReason.push(`project:${context.projectId}`);
  }

  const searchable = buildEntrySearchableText(entry);

  if (context.questionType === "behavioral") {
    if (isBehavioralStoryAnchorEntry(entry)) {
      score += 26;
      matchReason.push("behavioral:story-anchor");
    }
    if (entry.type === "answer_template") {
      score += 18;
      matchReason.push("behavioral:answer-template");
    }
  }

  if (
    context.questionType === "project-deep-dive" &&
    isProjectSpecificEntry(entry)
  ) {
    score += 18;
    matchReason.push("project:fact-anchor");
  }

  if (
    context.questionType === "ai-ml-system-design" &&
    isMetricsOrLogsQuery(context.query) &&
    isObservabilityEvaluationEntry(searchable)
  ) {
    score += 34;
    matchReason.push("aiml:metrics-observability");
  }

  if (isDiagramOverlayMemoryEntry(entry)) {
    score += 24;
    matchReason.push("diagram:overlay");
    const diagramSignalMatches = countDiagramOverlaySignalOverlap(
      context.query,
      searchable
    );
    if (diagramSignalMatches) {
      score += Math.min(diagramSignalMatches * 7, 28);
      matchReason.push(`diagram-signals:${diagramSignalMatches}`);
    }
  }

  if (context.projectAnchor) {
    const anchorTokens = tokenize(context.projectAnchor);
    const anchorMatches = countTokenOverlap(anchorTokens, tokenize(searchable));
    if (anchorMatches) {
      score += Math.min(anchorMatches * 8, 24);
      matchReason.push(`projectAnchor:${anchorMatches}`);
    }
  }

  if (context.topicDomain && context.topicDomain !== "unknown") {
    const domainMatches = countDomainSignalOverlap(
      context.topicDomain,
      searchable
    );
    if (domainMatches) {
      score += Math.min(domainMatches * 4, 16);
      matchReason.push(`topic:${context.topicDomain}`);
    }
  }

  if (context.askFrame === "past-project" && isProjectSpecificEntry(entry)) {
    score += 10;
    matchReason.push("askFrame:past-project");
  } else if (
    context.askFrame === "hypothetical-design" &&
    isSystemDesignGuidanceEntry(entry)
  ) {
    score += 8;
    matchReason.push("askFrame:hypothetical-design");
  }

  const titleMatches = countTokenOverlap(queryTokens, tokenize(entry.title));
  if (titleMatches) {
    score += titleMatches * 8;
    matchReason.push(`title:${titleMatches}`);
  }

  const tagMatches = countTokenOverlap(queryTokens, tokenize(entry.tags.join(" ")));
  if (tagMatches) {
    score += tagMatches * 10;
    matchReason.push(`tags:${tagMatches}`);
  }

  const keywordMatches = countTokenOverlap(
    queryTokens,
    tokenize(entry.keywords.join(" "))
  );
  if (keywordMatches) {
    score += keywordMatches * 6;
    matchReason.push(`keywords:${keywordMatches}`);
  }

  const summaryMatches = countTokenOverlap(
    queryTokens,
    tokenize([entry.summary, entry.content.slice(0, 600)].filter(Boolean).join(" "))
  );
  if (summaryMatches) {
    score += Math.min(summaryMatches * 2, 12);
    matchReason.push(`content:${summaryMatches}`);
  }

  const currentQuestionBoost = scoreCurrentQuestionRelevance(
    entry,
    currentQuestionTokens
  );
  if (currentQuestionBoost.score > 0) {
    score += currentQuestionBoost.score;
    matchReason.push(`currentQuestion:${currentQuestionBoost.score}`);
  }

  return {
    entry,
    score,
    matchReason,
    injectedContent: entry.content,
    runtimeRole: classifyRuntimeMemoryRole(entry, matchReason),
  };
}

function isBehavioralStoryAnchorEntry(entry: MemoryEntry) {
  if (!classifyRuntimeMemoryRole(entry).anchorEligible) return false;

  return (
    entry.type === "personal_story" ||
    entry.type === "resume_fact" ||
    entry.type === "answer_evidence" ||
    entry.type === "achievement_metric" ||
    entry.type === "project_context" ||
    /\b(story|behavioral|impact|situation|action|result|saved|deadline|ownership|frugality)\b/i.test(
      [entry.title, entry.tags.join(" "), entry.keywords.join(" ")]
        .filter(Boolean)
        .join(" ")
    )
  );
}

function isMetricsOrLogsQuery(query: string) {
  return /\b(metric|metrics|measure|evaluate|evaluation|eval|success|quality|accuracy|precision|recall|latency|p95|p99|throughput|qps|log|logs|logging|observability|trace|trajectory|cost|guardrail|monitor)\b/i.test(
    query
  );
}

function isObservabilityEvaluationEntry(searchable: string) {
  return /\b(observability|metric|metrics|evaluation|eval|logs|logging|trace|trajectory|tool-call|tool call|success rate|invalid action|latency|p95|p99|cost|guardrail|monitoring|offline eval|online metric)\b/i.test(
    searchable
  );
}

function countDiagramOverlaySignalOverlap(query: string, searchable: string) {
  const queryTokens = tokenize(query);
  const diagramSignals = [
    "rag",
    "retrieval",
    "ranking",
    "rerank",
    "embedding",
    "vector",
    "llm",
    "agent",
    "context",
    "trace",
    "evaluation",
    "eval",
    "feature",
    "training",
    "serving",
    "inventory",
    "reservation",
    "booking",
    "feed",
    "fanout",
    "geo",
    "location",
    "matching",
    "cache",
    "index",
    "cdc",
  ];

  return diagramSignals.filter(
    (signal) => queryTokens.has(signal) && searchable.includes(signal)
  ).length;
}

function buildEntrySearchableText(entry: MemoryEntry) {
  return [
    entry.projectId,
    entry.projectName,
    entry.type,
    entry.title,
    entry.tags.join(" "),
    entry.keywords.join(" "),
    entry.summary,
    entry.content.slice(0, 1000),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function countDomainSignalOverlap(
  topicDomain: Exclude<MemoryTopicDomain, "unknown">,
  searchable: string
) {
  const signals: Record<Exclude<MemoryTopicDomain, "unknown">, string[]> = {
    "ai-ml-infra": [
      "ai",
      "ml",
      "llm",
      "model",
      "embedding",
      "rag",
      "retrieval",
      "inference",
      "evaluation",
    ],
    "agentic-ai": [
      "agent",
      "agentic",
      "tool",
      "memory",
      "planner",
      "workflow",
      "autonomous",
    ],
    search: [
      "search",
      "semantic",
      "ranking",
      "retrieval",
      "opensearch",
      "neural",
      "vector",
    ],
    backend: [
      "backend",
      "service",
      "database",
      "api",
      "distributed",
      "scaling",
      "consistency",
    ],
  };

  return signals[topicDomain].filter((signal) => searchable.includes(signal))
    .length;
}

function isProjectSpecificEntry(entry: MemoryEntry) {
  return (
    entry.scope === "project" ||
    Boolean(entry.projectId || entry.projectName) ||
    [
      "answer_evidence",
      "working_summary",
      "project_context",
      "design_doc",
      "implementation_note",
      "decision_record",
      "investigation_note",
    ].includes(entry.type)
  );
}

function isProjectAnchorMismatch(
  entry: MemoryEntry,
  strictProjectAnchor: string | undefined
) {
  return !isMemoryProjectAnchorCompatible(entry, strictProjectAnchor);
}

function isSystemDesignGuidanceEntry(entry: MemoryEntry) {
  const searchable = buildEntrySearchableText(entry);
  return (
    entry.type === "interview_framework" ||
    entry.type === "evaluation_criteria" ||
    isDiagramOverlayMemoryEntry(entry) ||
    /\b(system design|architecture|distributed|scalability|consistency)\b/.test(
      searchable
    )
  );
}

function buildMemoryOverlaySelectionSummary(
  entries: RetrievedMemoryEntry[],
  rejectSummary: MemoryRejectSummary[],
  domainGateResult: ReturnType<typeof gateDiagramOverlayEntriesByDomain>
): MemoryOverlaySelectionSummary {
  const selected = entries.filter((item) =>
    isDiagramOverlayMemoryEntry(item.entry)
  );

  return {
    selectedEntryIds: selected.map((item) => item.entry.id),
    selectedTitles: selected.map((item) => item.entry.title),
    rejectedCount: rejectSummary.reduce((total, item) => total + item.count, 0),
    rejectSummary,
    domainGate: {
      allowedFamilies: domainGateResult.context.allowedFamilies,
      evidence: domainGateResult.context.evidence,
      blockedEntries: domainGateResult.rejected
        .filter((item) => item.reason === "diagram-overlay-domain-blocked")
        .map((item) => ({
          entryId: item.entryId,
          actualFamilies: item.actualFamilies,
        })),
    },
  };
}

function applyMemoryBudget(
  entries: RetrievedMemoryEntry[],
  maxChars: number,
  perEntryMaxChars: number
) {
  const budgetedEntries: RetrievedMemoryEntry[] = [];
  const omittedEntries: RetrievedMemoryEntry[] = [];
  let totalChars = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index];
    const headerChars = item.entry.title.length + item.entry.id.length + 80;
    const remaining = maxChars - totalChars - headerChars;
    if (remaining <= 0) {
      omittedEntries.push(...entries.slice(index));
      break;
    }

    const injectedContent = truncateText(
      item.entry.content,
      Math.min(perEntryMaxChars, remaining)
    );
    totalChars += injectedContent.length + headerChars;
    budgetedEntries.push({ ...item, injectedContent });
  }

  return { entries: budgetedEntries, omittedEntries, totalChars };
}

function dedupeRetrievedEntries(entries: RetrievedMemoryEntry[]) {
  const entryMap = new Map<string, RetrievedMemoryEntry>();
  for (const entry of entries) {
    const existing = entryMap.get(entry.entry.id);
    if (!existing || entry.score > existing.score) {
      entryMap.set(entry.entry.id, entry);
    }
  }
  return Array.from(entryMap.values());
}

function hasRetrievalMatch(item: RetrievedMemoryEntry) {
  return item.matchReason.some((reason) =>
    /^(project|projectAnchor|topic|askFrame|title|tags|keywords|content):/.test(
      reason
    ) ||
    reason === "behavioral:story-anchor" ||
    reason === "behavioral:answer-template" ||
    reason === "project:fact-anchor" ||
    reason === "aiml:metrics-observability"
  );
}

function hasRequiredTaggedHints(
  entry: MemoryEntry,
  query: string
) {
  const normalizedQuery = query.toLowerCase();
  const companyTags = entry.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.startsWith("company:"))
    .map((tag) => tag.slice("company:".length).trim())
    .filter(Boolean);

  if (
    companyTags.length &&
    !companyTags.some((company) =>
      normalizedQuery.includes(`company:${company}`)
    )
  ) {
    return false;
  }

  const lpTags = entry.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.startsWith("lp:"))
    .map((tag) => tag.slice("lp:".length).trim())
    .filter(Boolean);

  if (!lpTags.length) return true;

  return lpTags.some((principle) =>
    normalizedQuery.includes(`lp:${principle}`)
  );
}

function countTokenOverlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const token of right) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function tokenize(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return new Set(normalized.split(" ").filter((token) => token.length >= 2));
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated]`;
}

function monotonicNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number) {
  return Math.max(0, monotonicNow() - startedAt);
}
