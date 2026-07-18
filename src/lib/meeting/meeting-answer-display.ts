import type {
  ClarifyingQuestionOption,
  MeetingAnswerProfile,
  ParsedMeetingAnswer,
} from "./types";
import { parseMeetingAnswer } from "./meeting-answer.js";

export interface MeetingAnswerDisplayModel {
  primaryAnswer: string;
  chineseThinking: string;
  focusedQuestion: string;
  approach: string;
  whiteboard: string;
  code: string;
  complexity: string;
  clarifyingQuestion: string;
  clarifyingOptions: ClarifyingQuestionOption[];
  profile?: MeetingAnswerProfile;
  hasTechnicalDetails: boolean;
  parsedAnswer: ParsedMeetingAnswer;
}

export function buildMeetingAnswerDisplayModel({
  content,
  parsedAnswer,
  expectedProfile,
}: {
  content: string;
  parsedAnswer?: ParsedMeetingAnswer;
  expectedProfile?: MeetingAnswerProfile;
}): MeetingAnswerDisplayModel {
  const parsed =
    parsedAnswer?.rawContent === content.trim()
      ? parsedAnswer
      : parseMeetingAnswer(content, { expectedProfile });
  const sections = parsed.sections;
  const profile = expectedProfile ?? parsed.profile;
  const primaryAnswer = sections.answer ?? "";
  const approach = sections.approach ?? "";
  const focusedQuestion = sections.question ?? "";
  const hasTechnicalDetails = Boolean(
    (profile !== "compact-spoken" && profile !== undefined) ||
      approach ||
      sections.whiteboard ||
      sections.code ||
      sections.complexity
  );

  return {
    primaryAnswer,
    chineseThinking:
      sections.chineseThinking ||
      buildChineseThinkingFallback({
        primaryAnswer,
        approach,
        focusedQuestion,
        hasTechnicalDetails,
      }),
    focusedQuestion,
    approach,
    whiteboard: sections.whiteboard ?? "",
    code: sections.code ?? "",
    complexity: sections.complexity ?? "",
    clarifyingQuestion: sections.clarifyingQuestion ?? "",
    clarifyingOptions: sections.clarifyingOptions,
    profile,
    hasTechnicalDetails,
    parsedAnswer: parsed,
  };
}

export function overlayMeetingAnswerArtifacts(
  display: MeetingAnswerDisplayModel,
  artifacts: { whiteboard?: string; code?: string; complexity?: string }
): MeetingAnswerDisplayModel {
  return {
    ...display,
    whiteboard: normalizeArtifactText(artifacts.whiteboard) || display.whiteboard,
    code: normalizeArtifactText(artifacts.code) || display.code,
    complexity:
      normalizeArtifactText(artifacts.complexity) || display.complexity,
    hasTechnicalDetails: Boolean(
      display.hasTechnicalDetails ||
        artifacts.whiteboard ||
        artifacts.code ||
        artifacts.complexity
    ),
  };
}

function buildChineseThinkingFallback({
  primaryAnswer,
  approach,
  focusedQuestion,
  hasTechnicalDetails,
}: {
  primaryAnswer: string;
  approach: string;
  focusedQuestion: string;
  hasTechnicalDetails: boolean;
}) {
  if (hasTechnicalDetails) {
    if (approach.trim()) {
      return `先按这个思路组织回答：${toCompactHint(approach)}`;
    }
    if (primaryAnswer.trim()) {
      return `先给结论，再补关键理由：${toCompactHint(primaryAnswer)}`;
    }
    if (focusedQuestion.trim()) {
      return `先确认题目焦点，再围绕 ${toCompactHint(focusedQuestion)} 回答。`;
    }
    return "";
  }

  const source = primaryAnswer || approach;
  return source
    ? `先把意思压缩成可说出口的主线：${toCompactHint(source)}`
    : "";
}

function toCompactHint(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeArtifactText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized !== "-" ? normalized : "";
}
