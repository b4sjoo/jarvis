import type {
  MeetingAnswerContractVersion,
  MeetingAnswerProfile,
  MeetingAnswerSections,
  ParsedMeetingAnswer,
} from "./types";
import { parseClarifyingOptionsText } from "./clarifying-options.js";

type MeetingAnswerSectionKey = Exclude<
  keyof MeetingAnswerSections,
  "clarifyingOptions"
>;

type MeetingAnswerSectionDefinition = {
  key: MeetingAnswerSectionKey | "clarifyingOptions";
  canonicalLabel: string;
  labels: string[];
};

const MEETING_ANSWER_SECTION_DEFINITIONS: MeetingAnswerSectionDefinition[] = [
  {
    key: "chineseThinking",
    canonicalLabel: "中文思路",
    labels: ["中文思路", "Chinese thinking", "Meaning"],
  },
  {
    key: "question",
    canonicalLabel: "Question",
    labels: ["Question"],
  },
  {
    key: "answer",
    canonicalLabel: "Answer",
    labels: ["Answer"],
  },
  {
    key: "answer",
    canonicalLabel: "Reply",
    labels: ["Reply", "Suggested reply"],
  },
  {
    key: "approach",
    canonicalLabel: "Approach",
    labels: ["Approach"],
  },
  {
    key: "whiteboard",
    canonicalLabel: "Whiteboard",
    labels: ["Whiteboard", "Infrastructure diagram"],
  },
  {
    key: "code",
    canonicalLabel: "Code",
    labels: ["Code", "Implementation"],
  },
  {
    key: "complexity",
    canonicalLabel: "Complexity",
    labels: ["Complexity"],
  },
  {
    key: "clarifyingQuestion",
    canonicalLabel: "Clarifying question",
    labels: ["Clarifying question"],
  },
  {
    key: "clarifyingOptions",
    canonicalLabel: "Clarifying options",
    labels: ["Clarifying options"],
  },
];

const MEETING_ANSWER_BOUNDARY_LABELS = Array.from(
  new Set(
    MEETING_ANSWER_SECTION_DEFINITIONS.flatMap(
      (definition) => definition.labels
    )
  )
);

const EXPECTED_PROFILE_SECTIONS: Record<MeetingAnswerProfile, string[]> = {
  "compact-spoken": ["中文思路", "Answer"],
  technical: ["中文思路", "Question", "Answer"],
  coding: [
    "中文思路",
    "Question",
    "Answer",
    "Approach",
    "Code",
    "Complexity",
  ],
  "system-design": ["中文思路", "Question", "Answer", "Approach"],
};

export function parseMeetingAnswer(
  content: string,
  options: { expectedProfile?: MeetingAnswerProfile; now?: number } = {}
): ParsedMeetingAnswer {
  const rawContent = content.trim();
  const recognizedLabels = findRecognizedMeetingAnswerLabels(rawContent);

  if (!rawContent || rawContent === "-") {
    return {
      sections: { clarifyingOptions: [] },
      rawContent,
      contractVersion: "unstructured",
      profile: options.expectedProfile,
      parseStatus: "empty",
      primaryAnswerSource: "none",
      recognizedLabels,
      missingExpectedSections: expectedMissingSections(
        options.expectedProfile,
        { clarifyingOptions: [] }
      ),
      parsedAt: options.now ?? Date.now(),
    };
  }

  const chineseThinking = readMeetingAnswerSection(rawContent, [
    "中文思路",
    "Chinese thinking",
    "Meaning",
  ]);
  const question = readMeetingAnswerSection(rawContent, ["Question"]);
  const canonicalAnswer = readMeetingAnswerSection(rawContent, ["Answer"]);
  const legacyReply = readMeetingAnswerSection(rawContent, [
    "Reply",
    "Suggested reply",
  ]);
  const rawApproach = readMeetingAnswerSection(rawContent, ["Approach"]);
  const whiteboard = readMeetingAnswerSection(rawContent, [
    "Whiteboard",
    "Infrastructure diagram",
  ]);
  const rawCode = readMeetingAnswerSection(rawContent, [
    "Code",
    "Implementation",
  ]);
  const complexity = readMeetingAnswerSection(rawContent, ["Complexity"]);
  const clarifyingQuestion = readMeetingAnswerSection(rawContent, [
    "Clarifying question",
  ]);
  const clarifyingOptions = parseClarifyingOptionsText(
    readMeetingAnswerSection(rawContent, ["Clarifying options"])
  ) ?? [];
  const extractedCode = extractFirstCodeFence(rawApproach);
  const approach = extractedCode
    ? sanitizeMeetingAnswerSection(rawApproach.replace(extractedCode.fence, ""))
    : rawApproach;
  const code = sanitizeMeetingAnswerCode(rawCode || extractedCode?.code || "");
  const fallbackAnswer = recognizedLabels.length === 0 ? rawContent : "";
  const answer = canonicalAnswer || legacyReply || fallbackAnswer;
  const sections: MeetingAnswerSections = {
    chineseThinking: chineseThinking || undefined,
    question: question || undefined,
    answer: answer || undefined,
    approach: approach || undefined,
    whiteboard: whiteboard || undefined,
    code: code || undefined,
    complexity: complexity || undefined,
    clarifyingQuestion: clarifyingQuestion || undefined,
    clarifyingOptions,
  };
  const profile = options.expectedProfile ?? inferMeetingAnswerProfile(sections);
  const hasPartialSection =
    hasTrailingEmptySection(rawContent) || hasUnclosedCodeFence(rawContent);
  const parseStatus =
    recognizedLabels.length === 0
      ? "fallback"
      : hasPartialSection
        ? "partial"
        : "parsed";

  return {
    sections,
    rawContent,
    contractVersion: inferContractVersion({
      canonicalAnswer,
      legacyReply,
      recognizedLabels,
    }),
    profile,
    parseStatus,
    primaryAnswerSource: canonicalAnswer
      ? "answer"
      : legacyReply
        ? "reply-alias"
        : fallbackAnswer
          ? "fallback"
          : "none",
    recognizedLabels,
    missingExpectedSections: expectedMissingSections(profile, sections),
    parsedAt: options.now ?? Date.now(),
  };
}

export function readMeetingAnswerSection(content: string, labels: string[]) {
  const labelPattern = labels.map(escapeRegExp).join("|");
  const boundaryPattern = MEETING_ANSWER_BOUNDARY_LABELS.map(escapeRegExp).join(
    "|"
  );
  const labelLinePattern = buildSectionLabelLinePattern(labelPattern);
  const boundaryLinePattern = buildSectionLabelLinePattern(boundaryPattern);
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${labelLinePattern}([\\s\\S]*?)(?=\\n\\s*${boundaryLinePattern}|$)`,
    "i"
  );
  const match = pattern.exec(content);

  return sanitizeMeetingAnswerSection(match?.[1] ?? "");
}

export function sanitizeMeetingAnswerSection(value: string) {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s*/, "")
    .trim();

  return trimmed === "-" ? "" : trimmed;
}

export function sanitizeMeetingAnswerCode(value: string) {
  return stripOuterMeetingAnswerCodeFence(
    sanitizeMeetingAnswerSection(value)
  );
}

export function stripOuterMeetingAnswerCodeFence(value: string) {
  const trimmed = value.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);

  return match?.[1]?.trimEnd() ?? trimmed;
}

function inferContractVersion({
  canonicalAnswer,
  legacyReply,
  recognizedLabels,
}: {
  canonicalAnswer: string;
  legacyReply: string;
  recognizedLabels: string[];
}): MeetingAnswerContractVersion {
  if (legacyReply && !canonicalAnswer) return "legacy-live-v1";
  if (canonicalAnswer) return "meeting-answer-v2";
  if (recognizedLabels.length > 0) return "legacy-screen-v1";
  return "unstructured";
}

function inferMeetingAnswerProfile(
  sections: MeetingAnswerSections
): MeetingAnswerProfile | undefined {
  if (sections.code || sections.complexity) return "coding";
  if (sections.whiteboard) return "system-design";
  if (sections.question || sections.approach) return "technical";
  if (sections.answer || sections.chineseThinking) return "compact-spoken";
  return undefined;
}

function expectedMissingSections(
  profile: MeetingAnswerProfile | undefined,
  sections: MeetingAnswerSections
) {
  if (!profile) return [];

  const present = new Set<string>();
  if (sections.chineseThinking) present.add("中文思路");
  if (sections.question) present.add("Question");
  if (sections.answer) present.add("Answer");
  if (sections.approach) present.add("Approach");
  if (sections.whiteboard) present.add("Whiteboard");
  if (sections.code) present.add("Code");
  if (sections.complexity) present.add("Complexity");

  return EXPECTED_PROFILE_SECTIONS[profile].filter(
    (section) => !present.has(section)
  );
}

function findRecognizedMeetingAnswerLabels(content: string) {
  const recognized: string[] = [];

  for (const definition of MEETING_ANSWER_SECTION_DEFINITIONS) {
    const labelPattern = definition.labels.map(escapeRegExp).join("|");
    const linePattern = buildSectionLabelLinePattern(labelPattern);
    const pattern = new RegExp(`(?:^|\\n)\\s*${linePattern}`, "i");
    if (pattern.test(content)) recognized.push(definition.canonicalLabel);
  }

  return Array.from(new Set(recognized));
}

function hasTrailingEmptySection(content: string) {
  const boundaryPattern = MEETING_ANSWER_BOUNDARY_LABELS.map(escapeRegExp).join(
    "|"
  );
  const linePattern = buildSectionLabelLinePattern(boundaryPattern);
  return new RegExp(`(?:^|\\n)\\s*${linePattern}\\s*$`, "i").test(content);
}

function hasUnclosedCodeFence(content: string) {
  return (content.match(/```/g)?.length ?? 0) % 2 === 1;
}

function buildSectionLabelLinePattern(labelPattern: string) {
  const emphasis = "(?:\\*\\*|__)?";
  const prefix = `(?:#{1,6}\\s*)?(?:[-*]\\s*)?${emphasis}`;
  const label = `(?:${labelPattern})(?:\\s*\\([^\\n:：)]*\\))?`;
  const separator = `(?:\\s*[:：]\\s*${emphasis}\\s*|${emphasis}\\s*[:：]\\s*|${emphasis}\\s*(?:\\n|$))`;

  return `${prefix}${label}${separator}`;
}

function extractFirstCodeFence(value: string) {
  const match = /```[^\n]*\n[\s\S]*?\n?```/.exec(value);
  if (!match) return undefined;

  return {
    fence: match[0],
    code: stripOuterMeetingAnswerCodeFence(match[0]),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
