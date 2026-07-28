import type {
  InterviewPlaybookPhase,
  ParentQuestionType,
  ParsedMeetingAnswer,
  WhiteboardArtifact,
  WhiteboardDomainTrack,
  WhiteboardRenderState,
  WhiteboardUpdateSource,
} from "./types";
import type { ArtifactProjectionDecision } from "./meeting-answer-display.js";
import type { SettledAdvisorArtifactIntent } from "./settled-advisor-execution-plan.js";
import { parseMeetingAnswer } from "./meeting-answer.js";
import {
  areCompatibleParentContinuityTypes,
  normalizeCanonicalQuestionType,
} from "./task-taxonomy.js";
import { buildWhiteboardAsciiFallback } from "./whiteboard-ascii-fallback.js";

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
  renderValidation?: WhiteboardRenderValidationDecision;
  now?: number;
}

export interface WhiteboardArtifactDisplay {
  whiteboard: ArtifactProjectionDecision;
  isCached: boolean;
}

export type WhiteboardRenderCandidateKind =
  | "none"
  | "plain-text"
  | "mermaid";

export type WhiteboardRenderValidationDisposition =
  | "no-candidate"
  | "valid-text"
  | "valid-mermaid"
  | "invalid-mermaid";

export interface WhiteboardRenderValidationDecision {
  operationId: string;
  candidateKind: WhiteboardRenderCandidateKind;
  candidateFingerprint: string;
  disposition: WhiteboardRenderValidationDisposition;
  valid: boolean;
  durationMs: number;
  parserErrorClass?: string;
  parserErrorDetail?: string;
}

export interface WhiteboardRenderValidationInput {
  whiteboard?: string;
  operationId?: string;
}

export function isWhiteboardRevisionAuthorized({
  artifactIntent,
  policyAllowsWhiteboard,
}: {
  artifactIntent?: SettledAdvisorArtifactIntent;
  policyAllowsWhiteboard: boolean;
}) {
  return (
    policyAllowsWhiteboard &&
    (!artifactIntent || artifactIntent === "revise-whiteboard")
  );
}

interface MermaidModule {
  default: {
    parse: (
      text: string,
      options?: { suppressErrors?: boolean }
    ) => Promise<unknown>;
  };
}

let mermaidModulePromise: Promise<MermaidModule> | undefined;

export function prewarmWhiteboardRenderValidator() {
  void loadMermaidModule().catch(() => undefined);
}

export async function validateWhiteboardRenderCandidate({
  whiteboard,
  operationId = createWhiteboardValidationOperationId(),
}: WhiteboardRenderValidationInput): Promise<WhiteboardRenderValidationDecision> {
  const startedAt = performance.now();
  const normalized = normalizeWhiteboardText(whiteboard);
  const candidateFingerprint = fingerprintWhiteboard(normalized);
  if (!normalized) {
    return {
      operationId,
      candidateKind: "none",
      candidateFingerprint,
      disposition: "no-candidate",
      valid: true,
      durationMs: elapsedMs(startedAt),
    };
  }

  const mermaidBlocks = extractMermaidBlocks(normalized);
  const containsMermaidFence = /```[ \t]*mermaid\b/i.test(normalized);
  if (!containsMermaidFence) {
    return {
      operationId,
      candidateKind: "plain-text",
      candidateFingerprint,
      disposition: "valid-text",
      valid: true,
      durationMs: elapsedMs(startedAt),
    };
  }

  if (!mermaidBlocks.length) {
    return invalidMermaidDecision({
      operationId,
      candidateFingerprint,
      parserErrorClass: "unclosed-mermaid-fence",
      parserErrorDetail:
        "The Mermaid Markdown fence is not closed, so the diagram cannot be parsed.",
      startedAt,
    });
  }

  try {
    const mermaid = (await loadMermaidModule()).default;
    for (const block of mermaidBlocks) {
      if (!block) {
        return invalidMermaidDecision({
          operationId,
          candidateFingerprint,
          parserErrorClass: "empty-mermaid-diagram",
          parserErrorDetail: "The Mermaid block is empty.",
          startedAt,
        });
      }
      const parsed = await mermaid.parse(block, { suppressErrors: true });
      if (!parsed) {
        return invalidMermaidDecision({
          operationId,
          candidateFingerprint,
          parserErrorClass: "mermaid-syntax-error",
          parserErrorDetail:
            "The Mermaid parser rejected the diagram without a diagnostic message.",
          startedAt,
        });
      }
    }
  } catch (error) {
    return invalidMermaidDecision({
      operationId,
      candidateFingerprint,
      parserErrorClass: classifyMermaidParserError(error),
      parserErrorDetail: normalizeMermaidParserErrorDetail(error),
      startedAt,
    });
  }

  return {
    operationId,
    candidateKind: "mermaid",
    candidateFingerprint,
    disposition: "valid-mermaid",
    valid: true,
    durationMs: elapsedMs(startedAt),
  };
}

export function formatWhiteboardRenderValidationForTrace({
  decision,
  before,
  after,
}: {
  decision?: WhiteboardRenderValidationDecision;
  before?: Pick<WhiteboardArtifact, "revision">;
  after?: Pick<WhiteboardArtifact, "revision" | "renderState">;
}) {
  const candidateRevision = (before?.revision ?? 0) + 1;
  const visibleRevisionAfter = after?.revision;
  return {
    whiteboardRenderValidationOperationId: decision?.operationId,
    whiteboardRenderCandidateKind: decision?.candidateKind ?? "none",
    whiteboardRenderCandidateRevision: decision
      ? candidateRevision
      : undefined,
    whiteboardRenderValidationDisposition:
      decision?.disposition ?? "no-candidate",
    whiteboardRenderValidationDurationMs: decision?.durationMs ?? 0,
    whiteboardRenderParserErrorClass: decision?.parserErrorClass,
    whiteboardRenderParserErrorDetail: decision?.parserErrorDetail,
    whiteboardRenderVisibleRevisionBefore: before?.revision,
    whiteboardRenderVisibleRevisionAfter: visibleRevisionAfter,
    whiteboardRenderPreservedLastValid:
      decision?.valid === false &&
      Boolean(before?.revision && visibleRevisionAfter === before.revision),
    whiteboardRenderAnswerStreamingIndependent: true,
    whiteboardRenderStatus: after?.renderState?.status,
    whiteboardRenderFallbackKind: after?.renderState?.fallbackKind,
    whiteboardRenderFallbackReason: after?.renderState?.fallbackReason,
  };
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
  renderValidation,
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

  const candidateValidation = authorizeWhiteboardCandidate({
    whiteboard,
    renderValidation,
  });
  if (!candidateValidation.valid) {
    const preserved = preserveLastValidWhiteboard({
      existing,
      decision: candidateValidation,
      now,
    });
    if (preserved) return preserved;
    return createAsciiFallbackWhiteboard({
      parentTaskId,
      questionInstanceId,
      parentQuestionType,
      parentTopic,
      candidateWhiteboard: whiteboard,
      phase,
      traceId,
      selectedOverlayIds,
      updateSource,
      provisional,
      openConstraintCategories,
      revisionReason,
      decision: candidateValidation,
      now,
    });
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
    const id = createWhiteboardArtifactId();
    const revision = 1;
    return {
      id,
      parentTaskId,
      questionInstanceId,
      domainTrack: inferWhiteboardDomainTrack(parentQuestionType, whiteboard),
      archetypeIds: nextOverlayIds,
      selectedOverlayIds: nextOverlayIds,
      currentPhase: phase,
      title: buildWhiteboardTitle(parentTopic, parentQuestionType),
      content: whiteboard,
      summary,
      revision,
      provisional,
      openConstraintCategories: nextOpenConstraintCategories,
      revisionReason: nextRevisionReason,
      createdTraceId: traceId,
      lastUpdatedTraceId: traceId,
      renderState: buildValidRenderState({
        artifactId: id,
        parentTaskId,
        revision,
        decision: candidateValidation,
        now,
      }),
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
    if (existing.renderState?.status === "preserved-last-valid") {
      return {
        ...existing,
        renderState: buildValidRenderState({
          artifactId: existing.id,
          parentTaskId,
          revision: existing.revision,
          decision: candidateValidation,
          now,
        }),
        lastUpdatedTraceId: traceId,
        updatedAt: now,
      };
    }
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
    renderState: buildValidRenderState({
      artifactId: existing.id,
      parentTaskId,
      revision: existing.revision + 1,
      decision: candidateValidation,
      now,
    }),
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
  sourceParentTaskId,
  sourceParentQuestionType,
}: {
  activeParentTaskId: string;
  activeParentQuestionType?: string;
  artifact?: Pick<
    WhiteboardArtifact,
    "parentTaskId" | "content" | "renderState"
  >;
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

  if (artifact?.parentTaskId === activeParentTaskId) {
    return {
      whiteboard: { kind: "replace", value: artifact.content },
      isCached:
        !sourceMatchesParent ||
        !artifact.renderState ||
        artifact.renderState?.status === "preserved-last-valid",
    };
  }

  return clearWhiteboardArtifactDisplay();
}

function createWhiteboardArtifactId() {
  return `whiteboard_artifact_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createWhiteboardValidationOperationId() {
  return `whiteboard_validation_${Date.now()}_${Math.random()
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

export function normalizeWhiteboardRenderCandidate(
  value: string | undefined
) {
  return normalizeWhiteboardText(value);
}

function loadMermaidModule() {
  mermaidModulePromise ??= (
    import("mermaid") as Promise<MermaidModule>
  ).catch((error) => {
    mermaidModulePromise = undefined;
    throw error;
  });
  return mermaidModulePromise;
}

function extractMermaidBlocks(value: string) {
  return Array.from(
    value.matchAll(/```[ \t]*mermaid[^\S\r\n]*\r?\n([\s\S]*?)```/gi),
    (match) => match[1]?.trim() ?? ""
  );
}

export function extractWhiteboardMermaidBlocks(value: string) {
  return extractMermaidBlocks(normalizeWhiteboardText(value));
}

function authorizeWhiteboardCandidate({
  whiteboard,
  renderValidation,
}: {
  whiteboard: string;
  renderValidation?: WhiteboardRenderValidationDecision;
}): WhiteboardRenderValidationDecision {
  const normalized = normalizeWhiteboardText(whiteboard);
  const fingerprint = fingerprintWhiteboard(normalized);
  const containsMermaidFence = /```[ \t]*mermaid\b/i.test(normalized);
  if (!containsMermaidFence) {
    if (
      renderValidation?.candidateFingerprint === fingerprint &&
      renderValidation.disposition === "valid-text"
    ) {
      return renderValidation;
    }
    return {
      operationId: createWhiteboardValidationOperationId(),
      candidateKind: "plain-text",
      candidateFingerprint: fingerprint,
      disposition: "valid-text",
      valid: true,
      durationMs: 0,
    };
  }

  if (
    renderValidation?.candidateFingerprint === fingerprint &&
    renderValidation.disposition === "valid-mermaid" &&
    renderValidation.valid
  ) {
    return renderValidation;
  }

  return {
    operationId:
      renderValidation?.operationId ??
      createWhiteboardValidationOperationId(),
    candidateKind: "mermaid",
    candidateFingerprint: fingerprint,
    disposition: "invalid-mermaid",
    valid: false,
    durationMs: renderValidation?.durationMs ?? 0,
    parserErrorClass:
      renderValidation?.candidateFingerprint !== fingerprint
        ? "candidate-validation-mismatch"
        : renderValidation?.parserErrorClass ?? "validation-missing",
    parserErrorDetail:
      renderValidation?.candidateFingerprint !== fingerprint
        ? "The validated Mermaid content does not match the artifact candidate."
        : renderValidation?.parserErrorDetail ??
          "The Mermaid candidate did not have an authorized successful validation.",
  };
}

function buildValidRenderState({
  artifactId,
  parentTaskId,
  revision,
  decision,
  now,
}: {
  artifactId: string;
  parentTaskId: string;
  revision: number;
  decision: WhiteboardRenderValidationDecision;
  now: number;
}): WhiteboardRenderState {
  return {
    artifactId,
    parentTaskId,
    candidateRevision: revision,
    visibleRevision: revision,
    lastValidRevision: revision,
    status:
      decision.disposition === "valid-mermaid"
        ? "valid-mermaid"
        : "valid-text",
    validationOperationId: decision.operationId,
    candidateFingerprint: decision.candidateFingerprint,
    validationDurationMs: decision.durationMs,
    validatedAt: now,
  };
}

function preserveLastValidWhiteboard({
  existing,
  decision,
  now,
}: {
  existing?: WhiteboardArtifact;
  decision: WhiteboardRenderValidationDecision;
  now: number;
}): WhiteboardArtifact | undefined {
  if (!existing) return undefined;
  return {
    ...existing,
    renderState: {
      artifactId: existing.id,
      parentTaskId: existing.parentTaskId,
      candidateRevision: existing.revision + 1,
      visibleRevision: existing.revision,
      lastValidRevision: existing.revision,
      status: "preserved-last-valid",
      validationOperationId: decision.operationId,
      candidateFingerprint: decision.candidateFingerprint,
      validationDurationMs: decision.durationMs,
      parserErrorClass: decision.parserErrorClass,
      fallbackKind: "last-valid",
      fallbackReason: "candidate-render-validation-failed",
      validatedAt: now,
    },
  };
}

function createAsciiFallbackWhiteboard({
  parentTaskId,
  questionInstanceId,
  parentQuestionType,
  parentTopic,
  candidateWhiteboard,
  phase,
  traceId,
  selectedOverlayIds,
  updateSource,
  provisional,
  openConstraintCategories,
  revisionReason,
  decision,
  now,
}: {
  parentTaskId: string;
  questionInstanceId?: string;
  parentQuestionType: ParentQuestionType;
  parentTopic: string;
  candidateWhiteboard: string;
  phase: InterviewPlaybookPhase;
  traceId?: string;
  selectedOverlayIds: string[];
  updateSource: WhiteboardUpdateSource;
  provisional: boolean;
  openConstraintCategories: string[];
  revisionReason?: string;
  decision: WhiteboardRenderValidationDecision;
  now: number;
}): WhiteboardArtifact {
  const fallback = buildWhiteboardAsciiFallback(candidateWhiteboard);
  const id = createWhiteboardArtifactId();
  const overlayIds = uniqueIds(selectedOverlayIds);
  return {
    id,
    parentTaskId,
    questionInstanceId,
    domainTrack: inferWhiteboardDomainTrack(
      parentQuestionType,
      candidateWhiteboard
    ),
    archetypeIds: overlayIds,
    selectedOverlayIds: overlayIds,
    currentPhase: phase,
    title: buildWhiteboardTitle(parentTopic, parentQuestionType),
    content: fallback.content,
    summary: buildWhiteboardSummary(fallback.content),
    revision: 1,
    provisional,
    openConstraintCategories: uniqueIds(openConstraintCategories),
    revisionReason:
      revisionReason ??
      (provisional
        ? "provisional-requirement-framing"
        : "invalid-mermaid-ascii-fallback"),
    createdTraceId: traceId,
    lastUpdatedTraceId: traceId,
    renderState: {
      artifactId: id,
      parentTaskId,
      candidateRevision: 1,
      visibleRevision: 1,
      lastValidRevision: 1,
      status: "ascii-fallback",
      validationOperationId: decision.operationId,
      candidateFingerprint: decision.candidateFingerprint,
      validationDurationMs: decision.durationMs,
      parserErrorClass: decision.parserErrorClass,
      fallbackKind: "deterministic-ascii",
      fallbackReason: `invalid-mermaid:${fallback.source}`,
      validatedAt: now,
    },
    updateSource,
    createdAt: now,
    updatedAt: now,
  };
}

function invalidMermaidDecision({
  operationId,
  candidateFingerprint,
  parserErrorClass,
  parserErrorDetail,
  startedAt,
}: {
  operationId: string;
  candidateFingerprint: string;
  parserErrorClass: string;
  parserErrorDetail?: string;
  startedAt: number;
}): WhiteboardRenderValidationDecision {
  return {
    operationId,
    candidateKind: "mermaid",
    candidateFingerprint,
    disposition: "invalid-mermaid",
    valid: false,
    durationMs: elapsedMs(startedAt),
    parserErrorClass,
    parserErrorDetail,
  };
}

function classifyMermaidParserError(error: unknown) {
  if (!(error instanceof Error)) return "mermaid-parser-error";
  const normalizedName = error.name.trim().toLowerCase();
  if (normalizedName && normalizedName !== "error") {
    return `mermaid-${normalizedName.replace(/[^a-z0-9]+/g, "-")}`;
  }
  return "mermaid-parser-error";
}

function normalizeMermaidParserErrorDetail(error: unknown) {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "The Mermaid parser rejected the diagram.";
  return raw.replace(/\s+/g, " ").trim().slice(0, 600);
}

function fingerprintWhiteboard(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

export function fingerprintWhiteboardRenderCandidate(
  value: string | undefined
) {
  return fingerprintWhiteboard(normalizeWhiteboardText(value));
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
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
