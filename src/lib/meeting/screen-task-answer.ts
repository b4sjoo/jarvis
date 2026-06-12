import type { ScreenTaskAnswer } from "./types";

const SCREEN_TASK_SECTION_LABELS = [
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

export function parseScreenTaskAnswer(content: string): ScreenTaskAnswer {
  const rawContent = content.trim();
  const chineseThinking = readScreenTaskSection(rawContent, [
    "中文思路",
    "Chinese thinking",
  ]);
  const question = readScreenTaskSection(rawContent, ["Question"]);
  const answer = readScreenTaskSection(rawContent, ["Answer"]);
  const rawApproach = readScreenTaskSection(rawContent, ["Approach"]);
  const whiteboard = readScreenTaskSection(rawContent, [
    "Whiteboard",
    "Infrastructure diagram",
  ]);
  const rawCode = readScreenTaskSection(rawContent, ["Code", "Implementation"]);
  const complexity = readScreenTaskSection(rawContent, ["Complexity"]);
  const clarifyingQuestion = readScreenTaskSection(rawContent, [
    "Clarifying question",
  ]);
  const clarifyingOptions = parseClarifyingOptions(
    readScreenTaskSection(rawContent, ["Clarifying options"])
  );
  const extractedCode = extractFirstCodeFence(rawApproach);
  const approach = extractedCode
    ? sanitizeScreenTaskSection(rawApproach.replace(extractedCode.fence, ""))
    : rawApproach;
  const code = sanitizeScreenTaskCode(rawCode || extractedCode?.code || "");

  return {
    chineseThinking: chineseThinking || undefined,
    question: question || undefined,
    answer: answer || undefined,
    approach: approach || undefined,
    whiteboard: whiteboard || undefined,
    code: code || undefined,
    complexity: complexity || undefined,
    clarifyingQuestion: clarifyingQuestion || undefined,
    clarifyingOptions,
    rawContent,
    parsedAt: Date.now(),
  };
}

export function hasScreenTaskAnswerContent(answer: ScreenTaskAnswer) {
  return Boolean(
    answer.chineseThinking ||
      answer.question ||
      answer.answer ||
      answer.approach ||
      answer.whiteboard ||
      answer.code ||
      answer.complexity ||
      answer.clarifyingQuestion ||
      answer.clarifyingOptions?.length
  );
}

export function readScreenTaskSection(content: string, labels: string[]) {
  const labelPattern = labels.map(escapeRegExp).join("|");
  const boundaryPattern = SCREEN_TASK_SECTION_LABELS.map(escapeRegExp).join("|");
  const labelLinePattern = buildSectionLabelLinePattern(labelPattern);
  const boundaryLinePattern = buildSectionLabelLinePattern(boundaryPattern);
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${labelLinePattern}([\\s\\S]*?)(?=\\n\\s*${boundaryLinePattern}|$)`,
    "i"
  );
  const match = pattern.exec(content);

  return sanitizeScreenTaskSection(match?.[1] ?? "");
}

function buildSectionLabelLinePattern(labelPattern: string) {
  const emphasis = "(?:\\*\\*|__)?";
  const prefix = `(?:#{1,6}\\s*)?(?:[-*]\\s*)?${emphasis}`;
  const label = `(?:${labelPattern})(?:\\s*\\([^\\n:：)]*\\))?`;
  const separator = `(?:\\s*[:：]\\s*${emphasis}\\s*|${emphasis}\\s*[:：]\\s*|${emphasis}\\s*(?:\\n|$))`;

  return `${prefix}${label}${separator}`;
}

export function sanitizeScreenTaskSection(value: string) {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s*/, "")
    .trim();

  return trimmed === "-" ? "" : trimmed;
}

export function sanitizeScreenTaskCode(value: string) {
  return stripOuterCodeFence(sanitizeScreenTaskSection(value));
}

export function stripOuterCodeFence(value: string) {
  const trimmed = value.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);

  return match?.[1]?.trimEnd() ?? trimmed;
}

function extractFirstCodeFence(value: string) {
  const match = /```[^\n]*\n[\s\S]*?\n?```/.exec(value);
  if (!match) return undefined;

  return {
    fence: match[0],
    code: stripOuterCodeFence(match[0]),
  };
}

function parseClarifyingOptions(value: string) {
  const sanitized = sanitizeScreenTaskSection(value);
  if (!sanitized) return undefined;

  const withoutBrackets = sanitized.replace(/^\[|\]$/g, "");
  const candidates = withoutBrackets
    .split(/\n|\||,|;/)
    .map((candidate) => candidate.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .filter((candidate) => candidate !== "-")
    .slice(0, 4);

  if (!candidates.length) return undefined;

  return candidates.map((label, index) => ({
    id: `option-${index + 1}`,
    label,
    value: label,
  }));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
