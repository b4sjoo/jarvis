import type {
  InterviewPlaybookPhase,
  ParentQuestionType,
  WhiteboardArtifact,
  WhiteboardDomainTrack,
  WhiteboardUpdateSource,
} from "./types";

export interface WhiteboardArtifactUpdateInput {
  existing?: WhiteboardArtifact;
  parentTaskId: string;
  parentQuestionType: ParentQuestionType;
  parentTopic: string;
  finalContent: string;
  phase: InterviewPlaybookPhase;
  traceId?: string;
  selectedOverlayIds?: string[];
  updateSource: WhiteboardUpdateSource;
  now?: number;
}

export function updateWhiteboardArtifactFromAnswer({
  existing,
  parentTaskId,
  parentQuestionType,
  parentTopic,
  finalContent,
  phase,
  traceId,
  selectedOverlayIds = [],
  updateSource,
  now = Date.now(),
}: WhiteboardArtifactUpdateInput): WhiteboardArtifact | undefined {
  if (!isWhiteboardParentType(parentQuestionType)) return undefined;

  const whiteboard = normalizeWhiteboardText(
    readWhiteboardSection(finalContent)
  );

  if (!whiteboard) {
    return existing;
  }

  const nextOverlayIds = uniqueIds([
    ...(existing?.selectedOverlayIds ?? []),
    ...selectedOverlayIds,
  ]);
  const summary = buildWhiteboardSummary(whiteboard);

  if (!existing) {
    return {
      id: createWhiteboardArtifactId(),
      parentTaskId,
      domainTrack: inferWhiteboardDomainTrack(parentQuestionType, whiteboard),
      archetypeIds: nextOverlayIds,
      selectedOverlayIds: nextOverlayIds,
      currentPhase: phase,
      title: buildWhiteboardTitle(parentTopic, parentQuestionType),
      content: whiteboard,
      summary,
      revision: 1,
      createdTraceId: traceId,
      lastUpdatedTraceId: traceId,
      updateSource,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (
    existing.content === whiteboard &&
    existing.currentPhase === phase &&
    arraysEqual(existing.selectedOverlayIds, nextOverlayIds)
  ) {
    return existing;
  }

  return {
    ...existing,
    domainTrack: inferWhiteboardDomainTrack(parentQuestionType, whiteboard),
    archetypeIds: uniqueIds([...existing.archetypeIds, ...nextOverlayIds]),
    selectedOverlayIds: nextOverlayIds,
    currentPhase: phase,
    content: whiteboard,
    summary,
    revision: existing.revision + 1,
    lastUpdatedTraceId: traceId,
    updateSource,
    updatedAt: now,
  };
}

function createWhiteboardArtifactId() {
  return `whiteboard_artifact_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function isWhiteboardParentType(
  questionType: ParentQuestionType | undefined
) {
  return (
    questionType === "general-system-design" ||
    questionType === "ai-ml-system-design"
  );
}

function normalizeWhiteboardText(value: string | undefined) {
  const normalized = value
    ?.trim()
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (!normalized || normalized === "-") return "";
  return normalized;
}

const WHITEBOARD_SECTION_LABELS = [
  "中文思路",
  "Chinese thinking",
  "Question",
  "Answer",
  "Approach",
  "Whiteboard",
  "Infrastructure diagram",
  "Code",
  "Implementation",
  "Complexity",
  "Clarifying question",
  "Clarifying options",
];

function readWhiteboardSection(content: string) {
  const labels = ["Whiteboard", "Infrastructure diagram"];
  const labelPattern = labels.map(escapeRegExp).join("|");
  const boundaryPattern = WHITEBOARD_SECTION_LABELS.map(escapeRegExp).join("|");
  const labelLinePattern = buildSectionLabelLinePattern(labelPattern);
  const boundaryLinePattern = buildSectionLabelLinePattern(boundaryPattern);
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${labelLinePattern}([\\s\\S]*?)(?=\\n\\s*${boundaryLinePattern}|$)`,
    "i"
  );
  const match = pattern.exec(content.trim());

  return match?.[1] ?? "";
}

function buildSectionLabelLinePattern(labelPattern: string) {
  const emphasis = "(?:\\*\\*|__)?";
  const prefix = `(?:#{1,6}\\s*)?(?:[-*]\\s*)?${emphasis}`;
  const label = `(?:${labelPattern})(?:\\s*\\([^\\n:：)]*\\))?`;
  const separator = `(?:\\s*[:：]\\s*${emphasis}\\s*|${emphasis}\\s*[:：]\\s*|${emphasis}\\s*(?:\\n|$))`;

  return `${prefix}${label}${separator}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferWhiteboardDomainTrack(
  parentQuestionType: ParentQuestionType,
  content: string
): WhiteboardDomainTrack {
  if (parentQuestionType === "general-system-design") return "general_sd";
  if (/\b(rag|retrieval|llm|agent|prompt|embedding|vector)\b/i.test(content)) {
    return "genai_sd";
  }
  if (/\b(model|training|feature|label|inference|drift|eval)\b/i.test(content)) {
    return "ml_sd";
  }
  return "hybrid";
}

function buildWhiteboardTitle(
  parentTopic: string,
  parentQuestionType: ParentQuestionType
) {
  const topic = parentTopic.trim() || parentQuestionType;
  return topic.length > 80 ? `${topic.slice(0, 77)}...` : topic;
}

function buildWhiteboardSummary(content: string) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-*_`]+$/.test(line))
    .slice(0, 10);

  return lines.join(" ").replace(/\s+/g, " ").slice(0, 900);
}

function uniqueIds(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim()))).slice(0, 8);
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
