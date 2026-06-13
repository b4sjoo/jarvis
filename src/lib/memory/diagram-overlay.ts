import type {
  MemoryEntry,
  MemoryQuestionType,
  MemoryRejectReason,
} from "./types";

export function isDiagramOverlayMemoryEntry(entry: Pick<MemoryEntry, "type">) {
  return (
    entry.type === "architecture_diagram" ||
    entry.type === "whiteboard_overlay"
  );
}

export function getDiagramOverlayGateRejectReason(
  entry: Pick<MemoryEntry, "type">,
  questionType: MemoryQuestionType | undefined,
  query: string
): MemoryRejectReason | undefined {
  if (!isDiagramOverlayMemoryEntry(entry)) return undefined;

  if (
    questionType === "general-system-design" ||
    questionType === "system-design" ||
    questionType === "ai-ml-system-design"
  ) {
    return undefined;
  }

  if (
    (questionType === "project-deep-dive" || questionType === "field-knowledge") &&
    isArchitectureStyleQuery(query)
  ) {
    return undefined;
  }

  return "diagram-overlay-question-type-blocked";
}

function isArchitectureStyleQuery(query: string) {
  return /\b(architecture|diagram|whiteboard|pipeline|flow|layers?|components?|system design|infra|infrastructure|data path|serving path|retrieval path|write path|read path|draw|write it down|explain the layers)\b/i.test(
    query
  );
}
