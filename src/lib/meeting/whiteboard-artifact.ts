import type {
  InterviewPlaybookPhase,
  ParentQuestionType,
  ParsedMeetingAnswer,
  WhiteboardArtifact,
  WhiteboardDomainTrack,
  WhiteboardUpdateSource,
} from "./types";
import type { ArtifactProjectionDecision } from "./meeting-answer-display.js";
import { parseMeetingAnswer } from "./meeting-answer.js";
import {
  areCompatibleParentContinuityTypes,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";

export interface WhiteboardArtifactUpdateInput {
  existing?: WhiteboardArtifact;
  parentTaskId: string;
  questionInstanceId?: string;
  parentQuestionType: ParentQuestionType;
  parentTopic: string;
  finalContent: string;
  parsedAnswer?: ParsedMeetingAnswer;
  phase: InterviewPlaybookPhase;
  traceId?: string;
  selectedOverlayIds?: string[];
  updateSource: WhiteboardUpdateSource;
  provisional?: boolean;
  openConstraintCategories?: string[];
  revisionReason?: string;
  now?: number;
}

export interface WhiteboardArtifactDisplay {
  whiteboard: ArtifactProjectionDecision;
  isCached: boolean;
}

export function updateWhiteboardArtifactFromAnswer({
  existing,
  parentTaskId,
  questionInstanceId,
  parentQuestionType,
  parentTopic,
  finalContent,
  parsedAnswer,
  phase,
  traceId,
  selectedOverlayIds = [],
  updateSource,
  provisional = phase === "requirement_clarification",
  openConstraintCategories = [],
  revisionReason,
  now = Date.now(),
}: WhiteboardArtifactUpdateInput): WhiteboardArtifact | undefined {
  if (!isWhiteboardParentType(parentQuestionType)) return undefined;

  const parsed = parsedAnswer ?? parseMeetingAnswer(finalContent);
  if (parsed.parseStatus === "partial" && (existing || !provisional)) {
    return existing;
  }

  const whiteboard =
    normalizeWhiteboardText(parsed.sections.whiteboard) ||
    (!existing && provisional
      ? buildProvisionalWhiteboard(parentTopic, parentQuestionType)
      : "");
  if (!whiteboard) {
    return existing;
  }

  const nextOverlayIds = uniqueIds([
    ...(existing?.selectedOverlayIds ?? []),
    ...selectedOverlayIds,
  ]);
  const summary = buildWhiteboardSummary(whiteboard);
  const nextOpenConstraintCategories = uniqueIds(openConstraintCategories);
  const nextRevisionReason =
    revisionReason ??
    (provisional
      ? "provisional-requirement-framing"
      : updateSource === "manual-next"
        ? "manual-next"
        : "model-output");

  if (!existing) {
    return {
      id: createWhiteboardArtifactId(),
      parentTaskId,
      questionInstanceId,
      domainTrack: inferWhiteboardDomainTrack(parentQuestionType, whiteboard),
      archetypeIds: nextOverlayIds,
      selectedOverlayIds: nextOverlayIds,
      currentPhase: phase,
      title: buildWhiteboardTitle(parentTopic, parentQuestionType),
      content: whiteboard,
      summary,
      revision: 1,
      provisional,
      openConstraintCategories: nextOpenConstraintCategories,
      revisionReason: nextRevisionReason,
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
    existing.provisional === provisional &&
    arraysEqual(existing.selectedOverlayIds, nextOverlayIds) &&
    arraysEqual(
      existing.openConstraintCategories ?? [],
      nextOpenConstraintCategories
    )
  ) {
    return existing;
  }

  return {
    ...existing,
    questionInstanceId: existing.questionInstanceId ?? questionInstanceId,
    domainTrack: inferWhiteboardDomainTrack(parentQuestionType, whiteboard),
    archetypeIds: uniqueIds([...existing.archetypeIds, ...nextOverlayIds]),
    selectedOverlayIds: nextOverlayIds,
    currentPhase: phase,
    content: whiteboard,
    summary,
    revision: existing.revision + 1,
    provisional,
    openConstraintCategories: nextOpenConstraintCategories,
    revisionReason: nextRevisionReason,
    lastUpdatedTraceId: traceId,
    updateSource,
    updatedAt: now,
  };
}

function buildProvisionalWhiteboard(
  parentTopic: string,
  parentQuestionType: ParentQuestionType
) {
  const topic = parentTopic.trim() || "current design problem";
  if (parentQuestionType === "general-system-design") {
    return [
      "PROVISIONAL r1",
      `Known scope: ${topic}`,
      "Open: traffic/QPS, correctness/consistency, latency/availability, and non-goals.",
      "Client -> Interface/API boundary -> Core domain capability",
      "       -> State/source-of-truth boundary (TBD) -> Response",
      "Optional async/derived path: TBD if required by scale or workflow.",
    ].join("\n");
  }

  return [
    "PROVISIONAL r1",
    `Known use case/decision: ${topic}`,
    "Open: objective/success metric, data/ground truth, serving latency/cost, safety, and feedback.",
    "Input/data/context -> Preparation or retrieval/features (TBD)",
    "                   -> Model/agent/decision boundary (TBD)",
    "                   -> Serving/action -> Outcome",
    "Outcome/logs ------> Evaluation/feedback boundary (TBD)",
  ].join("\n");
}

export function resolveWhiteboardArtifactDisplay({
  activeParentTaskId,
  activeParentQuestionType,
  artifact,
  inlineWhiteboard,
  sourceParentTaskId,
  sourceParentQuestionType,
}: {
  activeParentTaskId: string;
  activeParentQuestionType?: string;
  artifact?: Pick<WhiteboardArtifact, "parentTaskId" | "content">;
  inlineWhiteboard?: string;
  sourceParentTaskId?: string;
  sourceParentQuestionType?: string;
}): WhiteboardArtifactDisplay {
  const activeType = normalizeCanonicalQuestionType(activeParentQuestionType);
  if (
    !activeParentTaskId ||
    (activeType !== "general-system-design" &&
      activeType !== "ai-ml-system-design")
  ) {
    return clearWhiteboardArtifactDisplay();
  }

  const sourceType = normalizeCanonicalQuestionType(sourceParentQuestionType);
  const sourceMatchesParent =
    sourceParentTaskId === activeParentTaskId &&
    Boolean(sourceType) &&
    areCompatibleParentContinuityTypes(sourceType, activeType);
  const normalizedInline = normalizeWhiteboardText(inlineWhiteboard);
  if (sourceMatchesParent && normalizedInline) {
    return {
      whiteboard: { kind: "replace", value: normalizedInline },
      isCached: false,
    };
  }

  if (artifact?.parentTaskId === activeParentTaskId) {
    return {
      whiteboard: { kind: "replace", value: artifact.content },
      isCached: true,
    };
  }

  return sourceMatchesParent
    ? { whiteboard: { kind: "preserve" }, isCached: false }
    : clearWhiteboardArtifactDisplay();
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

function clearWhiteboardArtifactDisplay(): WhiteboardArtifactDisplay {
  return { whiteboard: { kind: "clear" }, isCached: false };
}
