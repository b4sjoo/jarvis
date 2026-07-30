import { isMemoryProjectAnchorCompatible } from "../memory/project-anchor.js";
import { formatMemoryContext } from "../memory/context-format.js";
import {
  type MemoryRejectSummary,
  type MemoryRetrievalResult,
  type RetrievedMemoryEntry,
} from "../memory/types.js";
import type { ProjectBindingDecision } from "./types.js";

export type ProjectMemorySettlementState =
  | "not-applicable"
  | "settled"
  | "blocked-unsettled-binding";

export interface ProjectMemorySettlement {
  state: ProjectMemorySettlementState;
  memoryContext?: MemoryRetrievalResult;
  bindingAction: ProjectBindingDecision["action"];
  bindingRevision: number;
  projectId?: string;
  projectName?: string;
  candidateEntryIds: string[];
  selectedEntryIds: string[];
  rejectedEntryIds: string[];
  reason: string;
}

export function settleMemoryContextForProjectBinding({
  candidateContext,
  bindingDecision,
}: {
  candidateContext?: MemoryRetrievalResult;
  bindingDecision: ProjectBindingDecision;
}): ProjectMemorySettlement {
  if (!candidateContext) {
    return {
      state:
        bindingDecision.action === "not-applicable"
          ? "not-applicable"
          : "blocked-unsettled-binding",
      bindingAction: bindingDecision.action,
      bindingRevision: bindingDecision.bindingRevision,
      projectId: bindingDecision.binding?.projectId,
      projectName: bindingDecision.binding?.projectName,
      candidateEntryIds: [],
      selectedEntryIds: [],
      rejectedEntryIds: [],
      reason: "memory-context-unavailable",
    };
  }

  if (bindingDecision.action === "not-applicable") {
    return {
      state: "not-applicable",
      memoryContext: cloneMemoryContext(candidateContext),
      bindingAction: bindingDecision.action,
      bindingRevision: bindingDecision.bindingRevision,
      candidateEntryIds: candidateContext.entries.map(
        (item) => item.entry.id
      ),
      selectedEntryIds: candidateContext.entries.map(
        (item) => item.entry.id
      ),
      rejectedEntryIds: [],
      reason: "project-binding-not-required",
    };
  }

  const binding = bindingDecision.binding;
  const bindingAnchor = binding?.projectId || binding?.projectName;
  const selectedEntries = bindingAnchor
    ? candidateContext.entries.filter((item) =>
        isMemoryProjectAnchorCompatible(item.entry, bindingAnchor)
      )
    : candidateContext.entries.filter((item) =>
        isSafeWithoutSettledProject(item)
      );
  const selectedIds = new Set(
    selectedEntries.map((item) => item.entry.id)
  );
  const rejectedEntries = candidateContext.entries.filter(
    (item) => !selectedIds.has(item.entry.id)
  );
  const rejectSummary = appendSettlementRejectSummary(
    candidateContext.rejectSummary,
    rejectedEntries
  );
  const memoryContext = rebuildMemoryContext({
    candidateContext,
    selectedEntries,
    rejectSummary,
    bindingAnchor,
  });
  const unsettled =
    bindingDecision.action === "needs-selection" ||
    bindingDecision.action === "invalidate";

  return {
    state: unsettled ? "blocked-unsettled-binding" : "settled",
    memoryContext,
    bindingAction: bindingDecision.action,
    bindingRevision: bindingDecision.bindingRevision,
    projectId: binding?.projectId,
    projectName: binding?.projectName,
    candidateEntryIds: candidateContext.entries.map(
      (item) => item.entry.id
    ),
    selectedEntryIds: selectedEntries.map((item) => item.entry.id),
    rejectedEntryIds: rejectedEntries.map((item) => item.entry.id),
    reason: binding
      ? "memory-filtered-by-settled-project-binding"
      : "project-fact-memory-blocked-until-binding-settles",
  };
}

export function formatProjectMemorySettlementForTrace(
  settlement: ProjectMemorySettlement
): Record<string, unknown> {
  return {
    projectMemorySettlementState: settlement.state,
    projectMemoryBindingAction: settlement.bindingAction,
    projectMemoryBindingRevision: settlement.bindingRevision,
    projectMemoryProjectId: settlement.projectId,
    projectMemoryProjectName: settlement.projectName,
    projectMemoryCandidateEntryIds: settlement.candidateEntryIds,
    projectMemorySelectedEntryIds: settlement.selectedEntryIds,
    projectMemoryRejectedEntryIds: settlement.rejectedEntryIds,
    projectMemoryRejectedCount: settlement.rejectedEntryIds.length,
    projectMemorySettlementReason: settlement.reason,
  };
}

function rebuildMemoryContext({
  candidateContext,
  selectedEntries,
  rejectSummary,
  bindingAnchor,
}: {
  candidateContext: MemoryRetrievalResult;
  selectedEntries: RetrievedMemoryEntry[];
  rejectSummary: MemoryRejectSummary[];
  bindingAnchor?: string;
}): MemoryRetrievalResult {
  const selectedIds = new Set(
    selectedEntries.map((item) => item.entry.id)
  );

  return {
    ...candidateContext,
    entries: selectedEntries.map(cloneRetrievedEntry),
    contextText: formatMemoryContext(selectedEntries),
    totalChars: selectedEntries.reduce(
      (total, item) => total + item.injectedContent.length,
      0
    ),
    rejectedCount:
      candidateContext.rejectedCount +
      candidateContext.entries.length -
      selectedEntries.length,
    rejectSummary,
    overlaySelection: candidateContext.overlaySelection
      ? {
          ...candidateContext.overlaySelection,
          selectedEntryIds:
            candidateContext.overlaySelection.selectedEntryIds.filter(
              (entryId) => selectedIds.has(entryId)
            ),
          selectedTitles:
            candidateContext.overlaySelection.selectedTitles.filter(
              (_, index) =>
                selectedIds.has(
                  candidateContext.overlaySelection!.selectedEntryIds[index]
                )
            ),
        }
      : undefined,
    policySnapshot: {
      ...candidateContext.policySnapshot,
      strictProjectAnchor:
        bindingAnchor ??
        candidateContext.policySnapshot.strictProjectAnchor,
    },
  };
}

function appendSettlementRejectSummary(
  existing: MemoryRejectSummary[],
  rejectedEntries: RetrievedMemoryEntry[]
) {
  if (!rejectedEntries.length) {
    return existing.map((item) => ({
      ...item,
      sampleEntryIds: [...item.sampleEntryIds],
      sampleTitles: [...item.sampleTitles],
    }));
  }

  return [
    ...existing.map((item) => ({
      ...item,
      sampleEntryIds: [...item.sampleEntryIds],
      sampleTitles: [...item.sampleTitles],
    })),
    {
      reason: "settled-project-binding-mismatch" as const,
      count: rejectedEntries.length,
      sampleEntryIds: rejectedEntries
        .slice(0, 5)
        .map((item) => item.entry.id),
      sampleTitles: rejectedEntries
        .slice(0, 5)
        .map((item) => item.entry.title),
    },
  ];
}

function isSafeWithoutSettledProject(item: RetrievedMemoryEntry) {
  const entry = item.entry;
  return (
    entry.scope === "global" &&
    !entry.projectId &&
    !entry.projectName &&
    ![
      "answer_evidence",
      "achievement_metric",
      "personal_story",
      "working_summary",
      "project_context",
      "design_doc",
      "implementation_note",
      "decision_record",
      "investigation_note",
      "architecture_diagram",
      "whiteboard_overlay",
    ].includes(entry.type)
  );
}

function cloneMemoryContext(
  context: MemoryRetrievalResult
): MemoryRetrievalResult {
  return {
    ...context,
    entries: context.entries.map(cloneRetrievedEntry),
    rejectSummary: context.rejectSummary.map((item) => ({
      ...item,
      sampleEntryIds: [...item.sampleEntryIds],
      sampleTitles: [...item.sampleTitles],
    })),
    overlaySelection: context.overlaySelection
      ? {
          ...context.overlaySelection,
          selectedEntryIds: [
            ...context.overlaySelection.selectedEntryIds,
          ],
          selectedTitles: [...context.overlaySelection.selectedTitles],
          rejectSummary: context.overlaySelection.rejectSummary.map(
            (item) => ({
              ...item,
              sampleEntryIds: [...item.sampleEntryIds],
              sampleTitles: [...item.sampleTitles],
            })
          ),
        }
      : undefined,
    policySnapshot: { ...context.policySnapshot },
    performance: context.performance
      ? { ...context.performance }
      : undefined,
  };
}

function cloneRetrievedEntry(
  item: RetrievedMemoryEntry
): RetrievedMemoryEntry {
  return {
    ...item,
    entry: {
      ...item.entry,
      sourceIds: [...item.entry.sourceIds],
      tags: [...item.entry.tags],
      keywords: [...item.entry.keywords],
      useCases: [...item.entry.useCases],
      interviewFamilies: item.entry.interviewFamilies
        ? [...item.entry.interviewFamilies]
        : undefined,
      relatedEntryIds: [...item.entry.relatedEntryIds],
      evidenceEntryIds: [...item.entry.evidenceEntryIds],
    },
    matchReason: [...item.matchReason],
    runtimeRole: item.runtimeRole
      ? { ...item.runtimeRole }
      : undefined,
  };
}
