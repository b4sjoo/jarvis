import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { getShortcutsConfig } from "@/lib";
import {
  createSharedAsyncListenerLifecycle,
  type AsyncListenerCleanup,
} from "./shared-async-listener-lifecycle";

let lastCustomShortcutEventTimes: Map<string, number> = new Map();
const CUSTOM_SHORTCUT_DEBOUNCE_MS = 750;

// Global callback refs
let globalInputRef: HTMLInputElement | null = null;
let shortcutInvocationSequence = 0;

export interface GlobalShortcutInvocation {
  invocationId: string;
  shortcutActionId: string;
  receivedAt: number;
  disposition: "dispatch" | "debounced";
}

type GlobalShortcutCallback = (
  invocation: GlobalShortcutInvocation
) => void;

let globalCustomShortcutCallbacks: Map<
  string,
  GlobalShortcutCallback
> = new Map();

async function setupGlobalEventListeners() {
  const installed: AsyncListenerCleanup[] = [];
  try {
    installed.push(
      await listen("focus-text-input", () => {
        setTimeout(() => {
          if (globalInputRef) globalInputRef.focus();
        }, 100);
      })
    );
    installed.push(
      await listen<{ action: string }>(
        "custom-shortcut-triggered",
        (event) => {
          const actionId = event.payload.action;
          const now = Date.now();
          const lastEventTime =
            lastCustomShortcutEventTimes.get(actionId) ?? 0;
          const callback = globalCustomShortcutCallbacks.get(actionId);
          const invocation: GlobalShortcutInvocation = {
            invocationId: `shortcut_${now}_${++shortcutInvocationSequence}`,
            shortcutActionId: actionId,
            receivedAt: now,
            disposition:
              now - lastEventTime < CUSTOM_SHORTCUT_DEBOUNCE_MS
                ? "debounced"
                : "dispatch",
          };

          if (invocation.disposition === "debounced") {
            callback?.(invocation);
            return;
          }

          lastCustomShortcutEventTimes.set(actionId, now);
          if (callback) {
            callback(invocation);
          } else {
            console.warn(
              `No callback registered for custom shortcut: ${actionId}`
            );
          }
        }
      )
    );
    installed.push(
      await listen<Array<[string, string, string]>>(
        "shortcut-registration-error",
        (event) => {
          window.dispatchEvent(
            new CustomEvent("shortcutRegistrationError", {
              detail: event.payload,
            })
          );
        }
      )
    );
    return installed;
  } catch (error) {
    for (const unlisten of installed) {
      try {
        unlisten();
      } catch (cleanupError) {
        console.warn(
          "Error cleaning up partially installed shortcut listener:",
          cleanupError
        );
      }
    }
    throw error;
  }
}

const globalEventListenerLifecycle = createSharedAsyncListenerLifecycle({
  setup: setupGlobalEventListeners,
  onSetupError: (error) =>
    console.error("Failed to setup event listeners:", error),
  onCleanupError: (error) =>
    console.warn("Error cleaning up global shortcut listener:", error),
});

export const useGlobalShortcuts = () => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const customShortcutCallbacksRef = useRef<
    Map<string, GlobalShortcutCallback>
  >(new Map());

  const checkShortcutsRegistered = useCallback(async (): Promise<boolean> => {
    try {
      const registered = await invoke<boolean>("check_shortcuts_registered");
      return registered;
    } catch (error) {
      console.error("Failed to check shortcuts:", error);
      return false;
    }
  }, []);

  const getShortcuts = useCallback(async (): Promise<Record<
    string,
    string
  > | null> => {
    try {
      const shortcuts = await invoke<Record<string, string>>(
        "get_registered_shortcuts"
      );
      return shortcuts;
    } catch (error) {
      console.error("Failed to get shortcuts:", error);
      return null;
    }
  }, []);

  const updateShortcuts = useCallback(async (): Promise<boolean> => {
    try {
      const config = getShortcutsConfig();
      await invoke("update_shortcuts", { config });
      return true;
    } catch (error) {
      console.error("Failed to update shortcuts:", error);
      return false;
    }
  }, []);

  // Register input element for auto-focus
  const registerInputRef = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input;
    globalInputRef = input;
  }, []);

  // Register custom shortcut callback
  const registerCustomShortcutCallback = useCallback(
    (actionId: string, callback: GlobalShortcutCallback) => {
      customShortcutCallbacksRef.current.set(actionId, callback);
      globalCustomShortcutCallbacks.set(actionId, callback);
    },
    []
  );

  // Unregister custom shortcut callback
  const unregisterCustomShortcutCallback = useCallback((actionId: string) => {
    customShortcutCallbacksRef.current.delete(actionId);
    globalCustomShortcutCallbacks.delete(actionId);
  }, []);

  useEffect(() => {
    return globalEventListenerLifecycle.acquire();
  }, []);

  return {
    checkShortcutsRegistered,
    getShortcuts,
    updateShortcuts,
    registerInputRef,
    registerCustomShortcutCallback,
    unregisterCustomShortcutCallback,
  };
};
