import type {
  MemoryEntry,
  RetrievedMemoryEntry,
  RuntimeMemoryRole,
  RuntimeMemoryRoleDecision,
} from "./types.js";

const DIRECT_FACT_EVIDENCE_TYPES = new Set<MemoryEntry["type"]>([
  "resume_fact",
  "personal_story",
  "achievement_metric",
  "answer_evidence",
]);

const PROJECT_FACT_EVIDENCE_TYPES = new Set<MemoryEntry["type"]>([
  "working_summary",
  "project_context",
  "design_doc",
  "implementation_note",
  "decision_record",
  "investigation_note",
  "threat_model",
]);

const TEMPLATE_TYPES = new Set<MemoryEntry["type"]>([
  "answer_template",
  "cached_answer",
]);

const OVERLAY_TYPES = new Set<MemoryEntry["type"]>([
  "architecture_diagram",
  "whiteboard_overlay",
]);

export interface RuntimeMemoryRoleTelemetryEntry {
  entryId: string;
  entryType: MemoryEntry["type"];
  role: RuntimeMemoryRole;
  anchorEligible: boolean;
  anchorEligibilityReason: string;
  projectId?: string;
  projectName?: string;
  evidenceEntryIds: string[];
}

export interface RuntimeMemoryRoleTelemetry {
  entries: RuntimeMemoryRoleTelemetryEntry[];
  counts: Record<RuntimeMemoryRole, number>;
  anchorEligibleCount: number;
  anchorIneligibleCount: number;
}

export function classifyRuntimeMemoryRole(
  entry: MemoryEntry,
  _matchReason: string[] = []
): RuntimeMemoryRoleDecision {
  if (OVERLAY_TYPES.has(entry.type)) {
    return {
      role: "overlay",
      anchorEligible: false,
      anchorEligibilityReason: "visual-overlay-is-not-fact-evidence",
    };
  }

  if (TEMPLATE_TYPES.has(entry.type)) {
    return {
      role: "template",
      anchorEligible: false,
      anchorEligibilityReason: entry.evidenceEntryIds.length
        ? "template-requires-separately-retrieved-linked-evidence"
        : "template-has-no-linked-fact-evidence",
    };
  }

  if (DIRECT_FACT_EVIDENCE_TYPES.has(entry.type)) {
    return {
      role: "fact-evidence",
      anchorEligible: true,
      anchorEligibilityReason: `direct-fact-entry-type:${entry.type}`,
    };
  }

  if (PROJECT_FACT_EVIDENCE_TYPES.has(entry.type)) {
    if (hasConcreteProjectAssociation(entry)) {
      return {
        role: "fact-evidence",
        anchorEligible: true,
        anchorEligibilityReason: `project-scoped-fact-entry-type:${entry.type}`,
      };
    }

    return {
      role: "guidance",
      anchorEligible: false,
      anchorEligibilityReason: `project-fact-type-missing-project-association:${entry.type}`,
    };
  }

  return {
    role: "guidance",
    anchorEligible: false,
    anchorEligibilityReason: `guidance-entry-type:${entry.type}`,
  };
}

export function resolveRetrievedMemoryRole(
  item: RetrievedMemoryEntry
): RuntimeMemoryRoleDecision {
  return (
    item.runtimeRole ??
    classifyRuntimeMemoryRole(item.entry, item.matchReason)
  );
}

export function extractRuntimeFactAnchorLabels(
  entries: RetrievedMemoryEntry[]
) {
  return uniqueStrings(
    entries
      .filter((item) => resolveRetrievedMemoryRole(item).anchorEligible)
      .map((item) => getRuntimeFactAnchorLabel(item.entry))
  ).slice(0, 8);
}

export function getRuntimeFactAnchorLabel(entry: MemoryEntry) {
  return entry.projectName || entry.projectId || entry.title || entry.id;
}

export function buildRuntimeMemoryRoleTelemetry(
  entries: RetrievedMemoryEntry[]
): RuntimeMemoryRoleTelemetry {
  const counts: Record<RuntimeMemoryRole, number> = {
    "fact-evidence": 0,
    guidance: 0,
    template: 0,
    overlay: 0,
  };
  let anchorEligibleCount = 0;

  const telemetryEntries = entries.map((item) => {
    const decision = resolveRetrievedMemoryRole(item);
    counts[decision.role] += 1;
    if (decision.anchorEligible) anchorEligibleCount += 1;

    return {
      entryId: item.entry.id,
      entryType: item.entry.type,
      role: decision.role,
      anchorEligible: decision.anchorEligible,
      anchorEligibilityReason: decision.anchorEligibilityReason,
      projectId: item.entry.projectId,
      projectName: item.entry.projectName,
      evidenceEntryIds: [...item.entry.evidenceEntryIds],
    };
  });

  return {
    entries: telemetryEntries,
    counts,
    anchorEligibleCount,
    anchorIneligibleCount: entries.length - anchorEligibleCount,
  };
}

function hasConcreteProjectAssociation(entry: MemoryEntry) {
  return Boolean(entry.projectId?.trim() || entry.projectName?.trim());
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
