import type {
  MemoryOverlaySelectionSummary,
  MemoryRejectReason,
  MemoryRejectSummary,
} from "@/lib/memory";
import type { ActiveMeetingTask } from "./active-meeting-task";

export const MEETING_EVAL_TRACE_KEYS = {
  whiteboardArtifactId: "whiteboardArtifactId",
  whiteboardArtifactRevision: "whiteboardArtifactRevision",
  whiteboardArtifactDomainTrack: "whiteboardArtifactDomainTrack",
  manualPhaseFrom: "manualPhaseFrom",
  manualPhaseTo: "manualPhaseTo",
  manualPhaseTargetArtifact: "manualPhaseTargetArtifact",
  manualPhaseGuardStatus: "manualPhaseGuardStatus",
  manualPhaseAdvanceCommitted: "manualPhaseAdvanceCommitted",
  selectedDiagramOverlayIds: "selectedDiagramOverlayIds",
  rejectedDiagramOverlayCount: "rejectedDiagramOverlayCount",
  diagramOverlayRejectSummary: "diagramOverlayRejectSummary",
} as const;

export interface MeetingEvalTraceMetadata {
  whiteboardArtifactId?: string;
  whiteboardArtifactRevision?: number;
  whiteboardArtifactDomainTrack?: string;
  manualPhaseFrom?: string;
  manualPhaseTo?: string;
  manualPhaseTargetArtifact?: string;
  manualPhaseGuardStatus?: string;
  manualPhaseAdvanceCommitted?: boolean;
  selectedDiagramOverlayIds?: string[];
  rejectedDiagramOverlayCount?: number;
  diagramOverlayRejectSummary?: MemoryRejectSummary[];
}

export function buildWhiteboardEvalTraceMetadata(
  activeMeetingTask: ActiveMeetingTask | undefined
): MeetingEvalTraceMetadata {
  const artifact = activeMeetingTask?.parent.whiteboardArtifact;
  if (!artifact) return {};

  return {
    whiteboardArtifactId: artifact.id,
    whiteboardArtifactRevision: artifact.revision,
    whiteboardArtifactDomainTrack: artifact.domainTrack,
  };
}

export function buildDiagramOverlayEvalTraceMetadata(
  overlaySelection: MemoryOverlaySelectionSummary | undefined
): MeetingEvalTraceMetadata {
  if (!overlaySelection) return {};

  return {
    selectedDiagramOverlayIds: overlaySelection.selectedEntryIds,
    rejectedDiagramOverlayCount: overlaySelection.rejectedCount,
    diagramOverlayRejectSummary: overlaySelection.rejectSummary,
  };
}

export function readMeetingEvalTraceMetadata(
  metadataSources: Array<Record<string, unknown> | undefined>
): MeetingEvalTraceMetadata {
  const sources = metadataSources.filter(isRecord);

  return {
    whiteboardArtifactId: readFirstString(
      sources,
      MEETING_EVAL_TRACE_KEYS.whiteboardArtifactId
    ),
    whiteboardArtifactRevision: readFirstNumber(
      sources,
      MEETING_EVAL_TRACE_KEYS.whiteboardArtifactRevision
    ),
    whiteboardArtifactDomainTrack: readFirstString(
      sources,
      MEETING_EVAL_TRACE_KEYS.whiteboardArtifactDomainTrack
    ),
    manualPhaseFrom: readFirstString(
      sources,
      MEETING_EVAL_TRACE_KEYS.manualPhaseFrom
    ),
    manualPhaseTo: readFirstString(
      sources,
      MEETING_EVAL_TRACE_KEYS.manualPhaseTo
    ),
    manualPhaseTargetArtifact: readFirstString(
      sources,
      MEETING_EVAL_TRACE_KEYS.manualPhaseTargetArtifact
    ),
    manualPhaseGuardStatus: readFirstString(
      sources,
      MEETING_EVAL_TRACE_KEYS.manualPhaseGuardStatus
    ),
    manualPhaseAdvanceCommitted: readFirstBoolean(
      sources,
      MEETING_EVAL_TRACE_KEYS.manualPhaseAdvanceCommitted
    ),
    selectedDiagramOverlayIds: readFirstStringList(
      sources,
      MEETING_EVAL_TRACE_KEYS.selectedDiagramOverlayIds
    ),
    rejectedDiagramOverlayCount: readFirstNumber(
      sources,
      MEETING_EVAL_TRACE_KEYS.rejectedDiagramOverlayCount
    ),
    diagramOverlayRejectSummary: readFirstMemoryRejectSummary(
      sources,
      MEETING_EVAL_TRACE_KEYS.diagramOverlayRejectSummary
    ),
  };
}

function readFirstString(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = readString(source[key]);
    if (value) return value;
  }

  return undefined;
}

function readFirstNumber(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = readNumber(source[key]);
    if (value !== undefined) return value;
  }

  return undefined;
}

function readFirstBoolean(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }

  return undefined;
}

function readFirstStringList(sources: Record<string, unknown>[], key: string) {
  for (const source of sources) {
    const values = readStringList(source[key]);
    if (values.length) return values;
  }

  return undefined;
}

function readFirstMemoryRejectSummary(
  sources: Record<string, unknown>[],
  key: string
) {
  for (const source of sources) {
    const summary = readMemoryRejectSummary(source[key]);
    if (summary) return summary;
  }

  return undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readMemoryRejectSummary(value: unknown): MemoryRejectSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const summary = value.flatMap((item): MemoryRejectSummary[] => {
    if (!isRecord(item)) return [];
    const reason = readString(item.reason);
    const count = readNumber(item.count);
    if (!reason || count === undefined) return [];

    return [
      {
        reason: reason as MemoryRejectReason,
        count,
        sampleEntryIds: readStringList(item.sampleEntryIds),
        sampleTitles: readStringList(item.sampleTitles),
      },
    ];
  });

  return summary.length ? summary : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
