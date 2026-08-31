import type { ShortcutBinding } from "../../types/shortcuts.js";

export const RETIRED_DEFAULT_SHORTCUT_ACTION_IDS = new Set([
  "system_audio",
  "audio_recording",
  "screenshot",
]);

export const removeRetiredDefaultShortcutBindings = (
  bindings: Record<string, ShortcutBinding>
): Record<string, ShortcutBinding> =>
  Object.fromEntries(
    Object.entries(bindings).filter(
      ([actionId]) => !RETIRED_DEFAULT_SHORTCUT_ACTION_IDS.has(actionId)
    )
  );
