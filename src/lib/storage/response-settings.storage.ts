import { STORAGE_KEYS } from "@/config";
import {
  DEFAULT_RESPONSE_LENGTH,
  DEFAULT_LANGUAGE,
} from "../response-settings.constants";

export interface ResponseSettings {
  responseLength: string;
  language: string;
}

export const DEFAULT_RESPONSE_SETTINGS: ResponseSettings = {
  responseLength: DEFAULT_RESPONSE_LENGTH,
  language: DEFAULT_LANGUAGE,
};

/**
 * Get response settings from localStorage
 */
export const getResponseSettings = (): ResponseSettings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.RESPONSE_SETTINGS);
    if (!stored) {
      return DEFAULT_RESPONSE_SETTINGS;
    }

    const parsedSettings = JSON.parse(stored);

    return {
      responseLength:
        parsedSettings.responseLength ||
        DEFAULT_RESPONSE_SETTINGS.responseLength,
      language: parsedSettings.language || DEFAULT_RESPONSE_SETTINGS.language,
    };
  } catch (error) {
    console.error("Failed to get response settings:", error);
    return DEFAULT_RESPONSE_SETTINGS;
  }
};

/**
 * Save response settings to localStorage
 */
export const setResponseSettings = (settings: ResponseSettings): void => {
  try {
    localStorage.setItem(
      STORAGE_KEYS.RESPONSE_SETTINGS,
      JSON.stringify(settings)
    );
  } catch (error) {
    console.error("Failed to save response settings:", error);
  }
};

/**
 * Update response length
 */
export const updateResponseLength = (
  responseLength: string
): ResponseSettings => {
  const currentSettings = getResponseSettings();
  const newSettings = { ...currentSettings, responseLength };
  setResponseSettings(newSettings);
  return newSettings;
};

/**
 * Update language
 */
export const updateLanguage = (language: string): ResponseSettings => {
  const currentSettings = getResponseSettings();
  const newSettings = { ...currentSettings, language };
  setResponseSettings(newSettings);
  return newSettings;
};
