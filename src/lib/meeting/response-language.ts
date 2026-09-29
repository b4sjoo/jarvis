import type { MeetingResponseConfig } from "./types.js";

export const MEETING_RESPONSE_LANGUAGE_POLICY =
  "Keep 中文思路 in Chinese. For every question type, including Coding, follow the natural language preference for Question, Answer, Approach, Complexity explanations, Clarifying question, and Clarifying option prose. Preserve the exact protocol section labels, option IDs, project names, code identifiers and selected programming language. Language changes wording, not facts, task phase or artifact permission.";

export function formatMeetingResponseLanguage(language: MeetingResponseConfig["language"] = "auto") {
  const instruction = language === "english"
    ? "Use meeting-ready English for all response prose except 中文思路."
    : language === "chinese"
      ? "Use concise Chinese for all response prose, preserving important technical terms. This also applies to Coding."
      : "Use the language that best fits the visible task and transcript context for response prose.";
  return `Natural language: ${language}\n${instruction}\n${MEETING_RESPONSE_LANGUAGE_POLICY}`;
}
