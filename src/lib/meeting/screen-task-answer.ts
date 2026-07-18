import type { ParsedMeetingAnswer, ScreenTaskAnswer } from "./types";
import {
  parseMeetingAnswer,
  readMeetingAnswerSection,
  sanitizeMeetingAnswerCode,
  sanitizeMeetingAnswerSection,
  stripOuterMeetingAnswerCodeFence,
} from "./meeting-answer.js";

export function parseScreenTaskAnswer(content: string): ScreenTaskAnswer {
  return screenTaskAnswerFromParsedMeetingAnswer(parseMeetingAnswer(content));
}

export function screenTaskAnswerFromParsedMeetingAnswer(
  parsed: ParsedMeetingAnswer
): ScreenTaskAnswer {
  const sections = parsed.sections;

  return {
    ...sections,
    rawContent: parsed.rawContent,
    parsedAt: parsed.parsedAt,
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
  return readMeetingAnswerSection(content, labels);
}

export function sanitizeScreenTaskSection(value: string) {
  return sanitizeMeetingAnswerSection(value);
}

export function sanitizeScreenTaskCode(value: string) {
  return sanitizeMeetingAnswerCode(value);
}

export function stripOuterCodeFence(value: string) {
  return stripOuterMeetingAnswerCodeFence(value);
}
