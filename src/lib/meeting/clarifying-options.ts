import type { ClarifyingQuestionOption } from "./types";

const MAX_CLARIFYING_OPTIONS = 4;

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
  if (options?.length) {
    return normalizeClarifyingOptions(options);
  }

  return inferClarifyingOptionsFromQuestion(question);
}

export function normalizeClarifyingOptions(options: ClarifyingQuestionOption[]) {
  return buildOptionsFromCandidates(
    options.map((option) => option.label || option.value)
  );
}

export function isLikelyBooleanClarifyingQuestion(question: string) {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return true;
  if (/\b(or|versus|vs\.?)\b/.test(normalized)) return false;
  if (/(which|what|where|when|who|how many|how much)\b/.test(normalized)) {
    return false;
  }
  return /^(should|do|does|did|is|are|can|could|would|will|was|were)\b/.test(
    normalized
  );
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
