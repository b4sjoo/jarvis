import { STORAGE_KEYS } from "@/config";

export type CursorType = "invisible" | "default" | "auto";

export interface CustomizableState {
  appIcon: {
    isVisible: boolean;
  };
  alwaysOnTop: {
    isEnabled: boolean;
  };
  autostart: {
    isEnabled: boolean;
  };
  cursor: {
    type: CursorType;
  };
}

export const DEFAULT_CUSTOMIZABLE_STATE: CustomizableState = {
  appIcon: { isVisible: false },
  alwaysOnTop: { isEnabled: false },
  autostart: { isEnabled: true },
  cursor: { type: "invisible" },
};

const DOCK_STEALTH_MIGRATION_VERSION = "2026-06-default-hidden";

/**
 * Get customizable state from localStorage
 */
export const getCustomizableState = (): CustomizableState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CUSTOMIZABLE);
    if (!stored) {
      localStorage.setItem(
        STORAGE_KEYS.CUSTOMIZABLE_DOCK_STEALTH_MIGRATED,
        DOCK_STEALTH_MIGRATION_VERSION
      );
      return DEFAULT_CUSTOMIZABLE_STATE;
    }

    const parsedState = JSON.parse(stored);

    const state: CustomizableState = {
      appIcon: parsedState.appIcon || DEFAULT_CUSTOMIZABLE_STATE.appIcon,
      alwaysOnTop:
        parsedState.alwaysOnTop || DEFAULT_CUSTOMIZABLE_STATE.alwaysOnTop,
      autostart: parsedState.autostart || DEFAULT_CUSTOMIZABLE_STATE.autostart,
      cursor: parsedState.cursor || DEFAULT_CUSTOMIZABLE_STATE.cursor,
    };

    const migrationVersion = localStorage.getItem(
      STORAGE_KEYS.CUSTOMIZABLE_DOCK_STEALTH_MIGRATED
    );
    if (migrationVersion !== DOCK_STEALTH_MIGRATION_VERSION) {
      const migratedState = { ...state, appIcon: { isVisible: false } };
      setCustomizableState(migratedState);
      localStorage.setItem(
        STORAGE_KEYS.CUSTOMIZABLE_DOCK_STEALTH_MIGRATED,
        DOCK_STEALTH_MIGRATION_VERSION
      );
      return migratedState;
    }

    return state;
  } catch (error) {
    console.error("Failed to get customizable state:", error);
    return DEFAULT_CUSTOMIZABLE_STATE;
  }
};

/**
 * Save customizable state to localStorage
 */
export const setCustomizableState = (state: CustomizableState): void => {
  try {
    localStorage.setItem(STORAGE_KEYS.CUSTOMIZABLE, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to save customizable state:", error);
  }
};

/**
 * Update app icon visibility
 */
export const updateAppIconVisibility = (
  isVisible: boolean
): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, appIcon: { isVisible } };
  setCustomizableState(newState);
  return newState;
};

/**
 * Update always on top state
 */
export const updateAlwaysOnTop = (isEnabled: boolean): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, alwaysOnTop: { isEnabled } };
  setCustomizableState(newState);
  return newState;
};

/**
 * Update cursor type
 */
export const updateCursorType = (type: CursorType): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, cursor: { type } };
  setCustomizableState(newState);
  return newState;
};

/**
 * Update autostart state
 */
export const updateAutostart = (isEnabled: boolean): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, autostart: { isEnabled } };
  setCustomizableState(newState);
  return newState;
};
