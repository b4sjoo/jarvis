import { useEffect } from "react";
import {
  useGlobalShortcuts,
  type GlobalShortcutInvocation,
} from "./useGlobalShortcuts";

interface UseShortcutsProps {
  customShortcuts?: Record<
    string,
    (invocation: GlobalShortcutInvocation) => void
  >;
}

/**
 * Hook to manage global shortcuts for the application
 * Automatically registers callbacks for all shortcut actions
 */
export const useShortcuts = ({
  customShortcuts = {},
}: UseShortcutsProps = {}) => {
  const {
    registerCustomShortcutCallback,
    unregisterCustomShortcutCallback,
  } = useGlobalShortcuts();

  // Register custom shortcut callbacks
  useEffect(() => {
    Object.entries(customShortcuts).forEach(([actionId, callback]) => {
      registerCustomShortcutCallback(actionId, callback);
    });

    // Cleanup on unmount
    return () => {
      Object.keys(customShortcuts).forEach((actionId) => {
        unregisterCustomShortcutCallback(actionId);
      });
    };
  }, [
    customShortcuts,
    registerCustomShortcutCallback,
    unregisterCustomShortcutCallback,
  ]);

  return useGlobalShortcuts();
};
