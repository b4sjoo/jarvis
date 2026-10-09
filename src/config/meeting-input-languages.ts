import type { MeetingInputLanguage } from "../lib/meeting/types.js";
export type { MeetingInputLanguage } from "../lib/meeting/types.js";

export const MEETING_INPUT_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
] as const;

export const DEFAULT_MEETING_INPUT_LANGUAGES: readonly MeetingInputLanguage[] = ["en", "zh"];

export function isMeetingInputLanguageSet(value: unknown): value is MeetingInputLanguage[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length &&
    value.every(code => MEETING_INPUT_LANGUAGES.some(language => language.code === code));
}

// Missing settings are an upgrade default; damaged settings remain an explicit
// configuration failure rather than a model-confirmed language choice.
export function readMeetingInputLanguages(stored: string | null): readonly MeetingInputLanguage[] {
  if (stored === null) return [...DEFAULT_MEETING_INPUT_LANGUAGES];
  try {
    const parsed: unknown = JSON.parse(stored);
    return isMeetingInputLanguageSet(parsed) ? [...parsed] : [];
  } catch { return []; }
}
