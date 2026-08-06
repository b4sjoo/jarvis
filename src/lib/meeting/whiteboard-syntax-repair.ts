import {
  extractWhiteboardMermaidBlocks,
  fingerprintWhiteboardRenderCandidate,
} from "./whiteboard-artifact.js";
import type { RuntimeInferenceRuntimeJob } from "./runtime-inference-runtime.js";

export const WHITEBOARD_SYNTAX_REPAIR_PROMPT_VERSION =
  "whiteboard-syntax-repair-v2";
export const WHITEBOARD_SYNTAX_REPAIR_SCHEMA_VERSION = 1;
export const WHITEBOARD_SYNTAX_REPAIR_MAX_MERMAID_CHARS = 12_000;
export const WHITEBOARD_SYNTAX_REPAIR_MAX_ASCII_CHARS = 4_000;
export const WHITEBOARD_SYNTAX_REPAIR_MAX_RAW_OUTPUT_CHARS = 24_000;
export const WHITEBOARD_SYNTAX_REPAIR_MAX_PARSER_ERROR_CHARS = 600;

export type WhiteboardDiagramKind =
  | "flowchart"
  | "graph"
  | "sequence"
  | "unknown";

export interface WhiteboardSyntaxRepairInput {
  mermaid: string;
  parserError: string;
  parserContext?: string;
  diagramKind: WhiteboardDiagramKind;
}

export interface WhiteboardSyntaxRepairOutput {
  mermaid: string;
  asciiFallback: string;
  changedSyntaxOnly: true;
}

export type WhiteboardSyntaxRepairParseFailure =
  | "empty-output"
  | "non-json-output"
  | "invalid-json"
  | "unexpected-schema"
  | "missing-mermaid"
  | "missing-ascii-fallback"
  | "markdown-fence-forbidden"
  | "syntax-only-not-confirmed"
  | "output-too-large"
  | "semantic-anchor-mismatch";

export type WhiteboardSyntaxRepairParseResult =
  | {
      ok: true;
      value: WhiteboardSyntaxRepairOutput;
      preservedSemanticAnchors: string[];
    }
  | {
      ok: false;
      reason: WhiteboardSyntaxRepairParseFailure;
      missingSemanticAnchors?: string[];
    };

export interface WhiteboardSyntaxRepairLease {
  operationId: string;
  sessionId: string;
  runtimeEpoch: number;
  parentTaskId: string;
  parentRevision: number;
  artifactId?: string;
  candidateRevision: number;
  visibleRevision?: number;
  candidateFingerprint: string;
  validationOperationId: string;
  createdAt: number;
}

export interface WhiteboardSyntaxRepairJob
  extends RuntimeInferenceRuntimeJob {
  traceId: string;
  lease: WhiteboardSyntaxRepairLease;
  request: WhiteboardSyntaxRepairRequest;
}

export interface WhiteboardSyntaxRepairRequest {
  promptVersion: typeof WHITEBOARD_SYNTAX_REPAIR_PROMPT_VERSION;
  schemaVersion: typeof WHITEBOARD_SYNTAX_REPAIR_SCHEMA_VERSION;
  input: WhiteboardSyntaxRepairInput;
}

export interface WhiteboardSyntaxRepairRequestResult {
  rawOutput: string;
  parsed: WhiteboardSyntaxRepairParseResult;
  providerDisposition:
    | "completed-with-content"
    | "completed-empty"
    | "provider-error-content"
    | "provider-auth-error";
  parseDisposition: string;
  firstTokenAt?: number;
  completedAt: number;
}

export type WhiteboardSyntaxRepairAuthorizationReason =
  | "authorized"
  | "operation-superseded"
  | "session-changed"
  | "runtime-epoch-changed"
  | "parent-changed"
  | "parent-revision-changed"
  | "artifact-changed"
  | "candidate-revision-changed"
  | "candidate-content-changed"
  | "validation-operation-changed";

export interface WhiteboardSyntaxRepairAuthorization {
  authorized: boolean;
  reason: WhiteboardSyntaxRepairAuthorizationReason;
}

export function createWhiteboardSyntaxRepairRequest(input: {
  whiteboard: string;
  parserError: string;
}): WhiteboardSyntaxRepairRequest | undefined {
  const mermaidBlocks = extractWhiteboardMermaidBlocks(input.whiteboard);
  if (mermaidBlocks.length !== 1) return undefined;
  const mermaid = mermaidBlocks.join("\n\n");
  if (
    !mermaid.trim() ||
    mermaid.length > WHITEBOARD_SYNTAX_REPAIR_MAX_MERMAID_CHARS
  ) {
    return undefined;
  }
  return {
    promptVersion: WHITEBOARD_SYNTAX_REPAIR_PROMPT_VERSION,
    schemaVersion: WHITEBOARD_SYNTAX_REPAIR_SCHEMA_VERSION,
    input: {
      mermaid,
      parserError:
        input.parserError.replace(/\s+/g, " ").trim().slice(
          0,
          WHITEBOARD_SYNTAX_REPAIR_MAX_PARSER_ERROR_CHARS
        ) || "mermaid-syntax-error",
      parserContext: extractParserContext(mermaid, input.parserError),
      diagramKind: inferWhiteboardDiagramKind(mermaid),
    },
  };
}

export function buildWhiteboardSyntaxRepairPrompts(
  request: WhiteboardSyntaxRepairRequest
) {
  const systemPrompt = [
    "You repair Mermaid syntax for a live interview whiteboard.",
    "Change syntax only. Preserve every component, label, edge, group, and direction.",
    "Treat parserError and parserContext as the primary repair target.",
    'For unsafe labels, use a stable identifier with a quoted label, such as group_id["Display label"].',
    "Do not add architecture, delete constraints, rename concepts, or explain your work.",
    "Return exactly one JSON object and no Markdown fences.",
    'Schema: {"mermaid":"string","asciiFallback":"string","changedSyntaxOnly":true}',
    "mermaid must contain Mermaid source without a Markdown fence.",
    "asciiFallback must be a concise readable text diagram of the same graph.",
  ].join("\n");
  const userMessage = JSON.stringify({
    promptVersion: request.promptVersion,
    schemaVersion: request.schemaVersion,
    parserError: request.input.parserError,
    parserContext: request.input.parserContext,
    diagramKind: request.input.diagramKind,
    mermaid: request.input.mermaid,
  });
  return { systemPrompt, userMessage };
}

function extractParserContext(mermaid: string, parserError: string) {
  const lines = mermaid.split(/\r?\n/);
  const lineNumber = Number(
    parserError.match(/(?:line|row)\s+(\d+)/i)?.[1] ?? ""
  );
  if (Number.isInteger(lineNumber) && lineNumber > 0) {
    return lines
      .slice(Math.max(0, lineNumber - 2), Math.min(lines.length, lineNumber + 1))
      .map((line, index) => `${Math.max(1, lineNumber - 1) + index}: ${line}`)
      .join("\n")
      .slice(0, WHITEBOARD_SYNTAX_REPAIR_MAX_PARSER_ERROR_CHARS);
  }
  const suspiciousIndex = lines.findIndex(
    (line) =>
      /^\s*subgraph\s+.+[\s&/:()]/i.test(line) ||
      /\b[A-Za-z_][\w-]*\s*[\[{][^\]\}]*[&/:()][^\]\}]*[\]\}]/.test(
        line
      )
  );
  if (suspiciousIndex < 0) return undefined;
  return lines
    .slice(Math.max(0, suspiciousIndex - 1), suspiciousIndex + 2)
    .map((line, index) => `${Math.max(1, suspiciousIndex) + index}: ${line}`)
    .join("\n")
    .slice(0, WHITEBOARD_SYNTAX_REPAIR_MAX_PARSER_ERROR_CHARS);
}

export function parseWhiteboardSyntaxRepairOutput(
  rawOutput: string,
  request: WhiteboardSyntaxRepairRequest
): WhiteboardSyntaxRepairParseResult {
  const trimmed = rawOutput.trim();
  if (!trimmed) return { ok: false, reason: "empty-output" };
  if (
    !trimmed.startsWith("{") ||
    !trimmed.endsWith("}") ||
    trimmed.includes("```")
  ) {
    return {
      ok: false,
      reason: trimmed.includes("```")
        ? "markdown-fence-forbidden"
        : "non-json-output",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "unexpected-schema" };
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "asciiFallback" ||
    keys[1] !== "changedSyntaxOnly" ||
    keys[2] !== "mermaid"
  ) {
    return { ok: false, reason: "unexpected-schema" };
  }

  const mermaid =
    typeof parsed.mermaid === "string" ? parsed.mermaid.trim() : "";
  const asciiFallback =
    typeof parsed.asciiFallback === "string"
      ? parsed.asciiFallback.trim()
      : "";
  if (!mermaid) return { ok: false, reason: "missing-mermaid" };
  if (!asciiFallback) {
    return { ok: false, reason: "missing-ascii-fallback" };
  }
  if (mermaid.includes("```") || asciiFallback.includes("```")) {
    return { ok: false, reason: "markdown-fence-forbidden" };
  }
  if (parsed.changedSyntaxOnly !== true) {
    return { ok: false, reason: "syntax-only-not-confirmed" };
  }
  if (
    mermaid.length > WHITEBOARD_SYNTAX_REPAIR_MAX_MERMAID_CHARS ||
    asciiFallback.length > WHITEBOARD_SYNTAX_REPAIR_MAX_ASCII_CHARS
  ) {
    return { ok: false, reason: "output-too-large" };
  }

  const semanticAnchors = extractMermaidSemanticAnchors(
    request.input.mermaid
  );
  const repairedSemanticAnchors = extractMermaidSemanticAnchors(mermaid);
  const originalSearchText = normalizeSemanticText(request.input.mermaid);
  const repairedSearchText = normalizeSemanticText(
    `${mermaid}\n${asciiFallback}`
  );
  const missingSemanticAnchors = semanticAnchors.filter(
    (anchor) => !repairedSearchText.includes(anchor)
  );
  if (missingSemanticAnchors.length) {
    return {
      ok: false,
      reason: "semantic-anchor-mismatch",
      missingSemanticAnchors,
    };
  }
  const addedSemanticAnchors = repairedSemanticAnchors.filter(
    (anchor) =>
      !semanticAnchors.includes(anchor) &&
      !originalSearchText.includes(anchor)
  );
  if (addedSemanticAnchors.length) {
    return {
      ok: false,
      reason: "semantic-anchor-mismatch",
      missingSemanticAnchors: addedSemanticAnchors.map(
        (anchor) => `unexpected:${anchor}`
      ),
    };
  }
  if (
    inferWhiteboardDiagramKind(mermaid) !== request.input.diagramKind ||
    !arraysEqual(
      extractMermaidEdgeSignatures(request.input.mermaid),
      extractMermaidEdgeSignatures(mermaid)
    )
  ) {
    return {
      ok: false,
      reason: "semantic-anchor-mismatch",
      missingSemanticAnchors: ["edge-or-diagram-kind-changed"],
    };
  }

  return {
    ok: true,
    value: {
      mermaid,
      asciiFallback,
      changedSyntaxOnly: true,
    },
    preservedSemanticAnchors: semanticAnchors,
  };
}

export function createWhiteboardSyntaxRepairLease(input: {
  sessionId: string;
  runtimeEpoch: number;
  parentTaskId: string;
  parentRevision: number;
  artifactId?: string;
  candidateRevision: number;
  visibleRevision?: number;
  candidateWhiteboard: string;
  validationOperationId: string;
  operationId?: string;
  now?: number;
}): WhiteboardSyntaxRepairLease {
  return {
    operationId:
      input.operationId ??
      `whiteboard_repair_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    sessionId: input.sessionId,
    runtimeEpoch: input.runtimeEpoch,
    parentTaskId: input.parentTaskId,
    parentRevision: input.parentRevision,
    artifactId: input.artifactId,
    candidateRevision: input.candidateRevision,
    visibleRevision: input.visibleRevision,
    candidateFingerprint: fingerprintWhiteboardRenderCandidate(
      input.candidateWhiteboard
    ),
    validationOperationId: input.validationOperationId,
    createdAt: input.now ?? Date.now(),
  };
}

export function authorizeWhiteboardSyntaxRepairLease(
  lease: WhiteboardSyntaxRepairLease,
  current: {
    currentOperationId?: string;
    sessionId: string;
    runtimeEpoch: number;
    parentTaskId?: string;
    parentRevision?: number;
    artifactId?: string;
    candidateRevision?: number;
    visibleRevision?: number;
    candidateFingerprint?: string;
    validationOperationId?: string;
  }
): WhiteboardSyntaxRepairAuthorization {
  if (current.currentOperationId !== lease.operationId) {
    return denied("operation-superseded");
  }
  if (current.sessionId !== lease.sessionId) {
    return denied("session-changed");
  }
  if (current.runtimeEpoch !== lease.runtimeEpoch) {
    return denied("runtime-epoch-changed");
  }
  if (current.parentTaskId !== lease.parentTaskId) {
    return denied("parent-changed");
  }
  if (current.parentRevision !== lease.parentRevision) {
    return denied("parent-revision-changed");
  }
  if (current.artifactId !== lease.artifactId) {
    return denied("artifact-changed");
  }
  if (current.candidateRevision !== lease.candidateRevision) {
    return denied("candidate-revision-changed");
  }
  if (current.visibleRevision !== lease.visibleRevision) {
    return denied("candidate-revision-changed");
  }
  if (current.candidateFingerprint !== lease.candidateFingerprint) {
    return denied("candidate-content-changed");
  }
  if (current.validationOperationId !== lease.validationOperationId) {
    return denied("validation-operation-changed");
  }
  return { authorized: true, reason: "authorized" };
}

export function formatWhiteboardSyntaxRepairForTrace(input: {
  lease: WhiteboardSyntaxRepairLease;
  disposition: string;
  authorization?: WhiteboardSyntaxRepairAuthorization;
  providerDisposition?: string;
  parseDisposition?: string;
  queueWaitMs?: number;
  durationMs?: number;
  repairedValidationDisposition?: string;
  repairedParserErrorClass?: string;
  firstTokenAt?: number;
}) {
  return {
    whiteboardRepairOperationId: input.lease.operationId,
    whiteboardRepairMode: "shadow",
    whiteboardRepairDisposition: input.disposition,
    whiteboardRepairAuthorized: input.authorization?.authorized,
    whiteboardRepairAuthorizationReason: input.authorization?.reason,
    whiteboardRepairProviderDisposition: input.providerDisposition,
    whiteboardRepairParseDisposition: input.parseDisposition,
    whiteboardRepairQueueWaitMs: input.queueWaitMs,
    whiteboardRepairDurationMs: input.durationMs,
    whiteboardRepairFirstTokenAt: input.firstTokenAt,
    whiteboardRepairCandidateRevision: input.lease.candidateRevision,
    whiteboardRepairExpectedParentRevision: input.lease.parentRevision,
    whiteboardRepairExpectedVisibleRevision: input.lease.visibleRevision,
    whiteboardRepairCandidateFingerprint:
      input.lease.candidateFingerprint,
    whiteboardRepairValidationOperationId:
      input.lease.validationOperationId,
    whiteboardRepairRevalidationDisposition:
      input.repairedValidationDisposition,
    whiteboardRepairRevalidationParserErrorClass:
      input.repairedParserErrorClass,
    whiteboardRepairBehaviorMutationBlocked: true,
  };
}

export function inferWhiteboardDiagramKind(
  mermaid: string
): WhiteboardDiagramKind {
  const normalized = mermaid.trim().toLowerCase();
  if (/^(?:flowchart)\b/.test(normalized)) return "flowchart";
  if (/^(?:graph)\b/.test(normalized)) return "graph";
  if (/^(?:sequencediagram)\b/.test(normalized)) return "sequence";
  return "unknown";
}

function extractMermaidSemanticAnchors(mermaid: string) {
  const anchors = new Set<string>();
  for (const match of mermaid.matchAll(
    /(?:\[\s*"?(.*?)"?\s*\]|\(\s*"?(.*?)"?\s*\)|\{\s*"?(.*?)"?\s*\})/g
  )) {
    addSemanticAnchor(anchors, match[1] ?? match[2] ?? match[3]);
  }
  for (const line of mermaid.split(/\r?\n/)) {
    const subgraph = line.trim().match(/^subgraph\s+(.+)$/i)?.[1];
    if (subgraph) {
      const labeledSubgraph = subgraph.match(
        /^[A-Za-z_][\w-]*\s*\[\s*"?(.*?)"?\s*\]$/
      )?.[1];
      addSemanticAnchor(anchors, labeledSubgraph ?? subgraph);
    }
    if (!/(?:-->|---|-.->|==>|--\|)/.test(line)) continue;
    for (const token of line.matchAll(/\b[A-Za-z_][\w-]*\b/g)) {
      if (!MERMAID_RESERVED_WORDS.has(token[0].toLowerCase())) {
        addSemanticAnchor(anchors, token[0]);
      }
    }
  }
  return Array.from(anchors).filter((anchor) => anchor.length >= 1);
}

function extractMermaidEdgeSignatures(mermaid: string) {
  return mermaid
    .split(/\r?\n/)
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => /(?:-->|---|-.->|==>|~~~|--x|--o)/.test(line))
    .map((line) =>
      line
        .replace(/\|[^|]*\|/g, "")
        .replace(
          /([A-Za-z_][\w-]*)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g,
          "$1"
        )
        .replace(/\s+/g, "")
        .toLowerCase()
    )
    .sort();
}

const MERMAID_RESERVED_WORDS = new Set([
  "flowchart",
  "graph",
  "subgraph",
  "end",
  "direction",
  "style",
  "class",
  "classdef",
  "linkstyle",
  "td",
  "tb",
  "bt",
  "lr",
  "rl",
]);

function addSemanticAnchor(target: Set<string>, value: string | undefined) {
  const normalized = normalizeSemanticText(value ?? "");
  if (normalized && normalized.length <= 160) target.add(normalized);
}

function normalizeSemanticText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function denied(
  reason: Exclude<
    WhiteboardSyntaxRepairAuthorizationReason,
    "authorized"
  >
): WhiteboardSyntaxRepairAuthorization {
  return { authorized: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function arraysEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
