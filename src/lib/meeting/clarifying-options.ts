import type { ClarifyingOptionSource } from "./types.js";
import type { ClarifyingQuestionOption } from "./types";

const MAX_CLARIFYING_OPTIONS = 4;
const MAX_PROJECT_CLARIFYING_OPTIONS = 3;

export interface ClarifyingOptionDisplayModel {
  options: ClarifyingQuestionOption[];
  source: ClarifyingOptionSource;
  showBooleanFallback: boolean;
  misleadingBooleanFallbackPrevented: boolean;
}

export interface ProjectBindingClarifyingCandidate {
  projectId?: string;
  projectName: string;
}

export function parseClarifyingOptionsText(
  value: string
): ClarifyingQuestionOption[] | undefined {
  const sanitized = sanitizeOptionText(value);
  if (!sanitized) return undefined;

  const jsonOptions = parseJsonOptions(sanitized);
  if (jsonOptions.length) return jsonOptions;

  const normalized = sanitized
    .replace(/^\[|\]$/g, "")
    .replace(/\s+(?=(?:[A-Da-d]|\d{1,2})[\).:]\s+)/g, "\n");
  const rawCandidates = normalized.includes("\n")
    ? normalized.split(/\n+/)
    : normalized.split(/\s+\|\s+|\s*;\s*/);
  const candidates = buildOptionsFromCandidates(rawCandidates);

  if (candidates.length > 1) return candidates;

  return buildOptionsFromCandidates(splitInlineOptionList(sanitized));
}

export function getDisplayClarifyingOptions({
  question,
  options,
}: {
  question: string;
  options?: ClarifyingQuestionOption[];
}) {
  return buildClarifyingOptionDisplayModel({ question, options }).options;
}

export function buildClarifyingOptionDisplayModel({
  question,
  options,
  projectBindingCandidates,
  projectBindingNeedsSelection = false,
  projectIdentityPending = false,
}: {
  question: string;
  options?: ClarifyingQuestionOption[];
  projectBindingCandidates?: ProjectBindingClarifyingCandidate[];
  projectBindingNeedsSelection?: boolean;
  projectIdentityPending?: boolean;
}): ClarifyingOptionDisplayModel {
  if (projectIdentityPending) {
    return {
      options: [], source: "none", showBooleanFallback: false,
      misleadingBooleanFallbackPrevented: Boolean(question.trim()),
    };
  }
  const structuredOptions = normalizeClarifyingOptions(options ?? []);
  if (structuredOptions.length) {
    return buildDisplayModel(structuredOptions, "structured-answer");
  }

  if (projectBindingNeedsSelection) {
    const projectOptions = buildProjectBindingOptions(
      projectBindingCandidates ?? []
    );
    if (projectOptions.length) {
      return buildDisplayModel(projectOptions, "project-binding");
    }
  }

  const literalOptions = inferClarifyingOptionsFromQuestion(question);
  if (literalOptions.length > 1) {
    return buildDisplayModel(literalOptions, "question-literal");
  }

  if (isLikelyBooleanClarifyingQuestion(question)) {
    return {
      options: [],
      source: "boolean-fallback",
      showBooleanFallback: true,
      misleadingBooleanFallbackPrevented: false,
    };
  }

  return {
    options: [],
    source: "none",
    showBooleanFallback: false,
    misleadingBooleanFallbackPrevented: Boolean(question.trim()),
  };
}

export function readProjectBindingClarifyingCandidates(
  metadata: Record<string, unknown> | undefined
): {
  needsSelection: boolean;
  candidates: ProjectBindingClarifyingCandidate[];
} {
  const needsSelection = metadata?.projectBindingAction === "needs-selection";
  if (!needsSelection || !Array.isArray(metadata.projectBindingCandidates)) {
    return { needsSelection, candidates: [] };
  }

  const candidates = metadata.projectBindingCandidates
    .map<ProjectBindingClarifyingCandidate | undefined>((value) => {
      if (!value || typeof value !== "object") return undefined;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.projectName !== "string") return undefined;
      const projectName = candidate.projectName.trim();
      if (!projectName) return undefined;
      return typeof candidate.projectId === "string"
        ? { projectId: candidate.projectId, projectName }
        : { projectName };
    })
    .filter(
      (candidate): candidate is ProjectBindingClarifyingCandidate =>
        Boolean(candidate)
    );

  return { needsSelection, candidates };
}

export function normalizeClarifyingOptions(options: ClarifyingQuestionOption[]) {
  return buildOptionsFromCandidates(
    options.map((option) => option.label || option.value)
  );
}

export function isLikelyBooleanClarifyingQuestion(question: string) {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(or|versus|vs\.?)\b/.test(normalized)) return false;
  if (
    /\b(which|what|where|when|who|why|how|choose|pick|select|option)\b/.test(
      normalized
    )
  ) {
    return false;
  }
  return /^(should|do|does|did|is|are|can|could|would|will|was|were|shall|may)\b/.test(
    normalized
  );
}

function buildDisplayModel(
  options: ClarifyingQuestionOption[],
  source: ClarifyingOptionSource
): ClarifyingOptionDisplayModel {
  return {
    options,
    source,
    showBooleanFallback: false,
    misleadingBooleanFallbackPrevented: false,
  };
}

function buildProjectBindingOptions(
  candidates: ProjectBindingClarifyingCandidate[]
) {
  const unique = candidates.reduce<ProjectBindingClarifyingCandidate[]>(
    (result, candidate) => {
      const identity = (candidate.projectId ?? candidate.projectName)
        .trim()
        .toLowerCase();
      if (
        identity &&
        !result.some(
          (item) =>
            (item.projectId ?? item.projectName).trim().toLowerCase() ===
            identity
        )
      ) {
        result.push(candidate);
      }
      return result;
    },
    []
  );

  return unique.slice(0, MAX_PROJECT_CLARIFYING_OPTIONS).map((candidate, index) => ({
    id: `project-${buildOptionId(
      candidate.projectId ?? candidate.projectName,
      index
    )}`,
    label: candidate.projectName,
    value: candidate.projectId ?? candidate.projectName,
  }));
}

function inferClarifyingOptionsFromQuestion(question: string) {
  const normalized = question.trim();
  if (!normalized || isLikelyBooleanClarifyingQuestion(normalized)) {
    return [];
  }

  const afterColon = normalized.includes(":")
    ? normalized.slice(normalized.lastIndexOf(":") + 1)
    : stripClarifyingQuestionFrame(normalized);
  const fromInlineList = buildOptionsFromCandidates(
    splitInlineOptionList(afterColon.replace(/\?+$/g, ""))
  );

  if (fromInlineList.length > 1) return fromInlineList;

  const orSplit = afterColon
    .replace(/\?+$/g, "")
    .split(/\s+\bor\b\s+|\s+\bversus\b\s+|\s+\bvs\.?\s+/i);

  return buildOptionsFromCandidates(orSplit);
}

function stripClarifyingQuestionFrame(question: string) {
  return question
    .replace(/\?+$/g, "")
    .replace(
      /^(?:should|would|could|can|do)\s+(?:i|we)\s+(?:focus on|prioritize|choose|use|optimize for|start with)\s+/i,
      ""
    )
    .replace(
      /\s+(?:for|in|on)\s+(?:this|the)\s+(?:design|system|answer|problem|task)$/i,
      ""
    )
    .trim();
}

function parseJsonOptions(value: string) {
  if (!value.startsWith("[")) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];

    return buildOptionsFromCandidates(
      parsed.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const candidate = item as { label?: unknown; value?: unknown };
          return String(candidate.label ?? candidate.value ?? "");
        }
        return "";
      })
    );
  } catch {
    return [];
  }
}

function splitInlineOptionList(value: string) {
  return value
    .replace(/\s+\bor\b\s+/gi, ",")
    .split(/\s*,\s*/)
    .map((candidate) => candidate.trim());
}

function buildOptionsFromCandidates(candidates: string[]) {
  const labels = candidates
    .map(cleanOptionCandidate)
    .filter(Boolean)
    .filter((candidate) => candidate !== "-")
    .reduce<string[]>((unique, candidate) => {
      const normalized = candidate.toLowerCase();
      if (!unique.some((item) => item.toLowerCase() === normalized)) {
        unique.push(candidate);
      }
      return unique;
    }, [])
    .slice(0, MAX_CLARIFYING_OPTIONS);

  if (!labels.length) return [];

  return labels.map((label, index) => ({
    id: buildOptionId(label, index),
    label,
    value: label,
  }));
}

function cleanOptionCandidate(candidate: string) {
  return sanitizeOptionText(candidate)
    .replace(/^[-*]\s*/, "")
    .replace(/^(?:option\s*)?(?:[A-Da-d]|\d{1,2})[\).:-]\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function sanitizeOptionText(value: string) {
  return value
    .trim()
    .replace(/^[-*]\s*/, "")
    .trim();
}

function buildOptionId(label: string, index: number) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  return slug ? `option-${slug}` : `option-${index + 1}`;
}
