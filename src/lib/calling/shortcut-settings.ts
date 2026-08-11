export type ShortcutAction =
  | "toggle-visibility"
  | "toggle-interface"
  | "toggle-listening"
  | "request-guidance"
  | "end-call";

export interface ShortcutBinding {
  action: ShortcutAction;
  accelerator: string;
}

export interface ShortcutSettings {
  revision: number;
  bindings: Record<ShortcutAction, string>;
}

export interface ShortcutRegistrationFailure {
  action: ShortcutAction;
  accelerator: string;
  message: string;
}

export const SHORTCUT_SETTINGS_STORAGE_KEY = "moss.shortcut-settings.v1";

export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  "toggle-visibility": "Show or hide MOSS",
  "toggle-interface": "Switch control and companion",
  "toggle-listening": "Start, pause, or resume listening",
  "request-guidance": "Request guidance",
  "end-call": "End current call",
};

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  revision: 1,
  bindings: {
    "toggle-visibility": "CommandOrControl+Shift+M",
    "toggle-interface": "CommandOrControl+Shift+L",
    "toggle-listening": "CommandOrControl+Shift+P",
    "request-guidance": "CommandOrControl+Shift+A",
    "end-call": "CommandOrControl+Shift+E",
  },
};

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const shortcutPattern =
  /^(?:(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Escape|Tab|Arrow(?:Up|Down|Left|Right))$/i;

export function normalizeShortcutAccelerator(value: string) {
  return value
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("+");
}

export function validateShortcutSettings(settings: ShortcutSettings) {
  const seen = new Map<string, ShortcutAction>();
  for (const action of Object.keys(settings.bindings) as ShortcutAction[]) {
    const accelerator = normalizeShortcutAccelerator(settings.bindings[action]);
    if (!shortcutPattern.test(accelerator)) {
      throw new Error(
        `${SHORTCUT_ACTION_LABELS[action]} has an invalid shortcut. Use modifiers and one key, for example CommandOrControl+Shift+M.`
      );
    }
    const canonical = accelerator.toLowerCase();
    const existing = seen.get(canonical);
    if (existing) {
      throw new Error(
        `${SHORTCUT_ACTION_LABELS[action]} conflicts with ${SHORTCUT_ACTION_LABELS[existing]}.`
      );
    }
    seen.set(canonical, action);
  }
}

export function normalizeShortcutSettings(
  value: Partial<ShortcutSettings> | null | undefined
): ShortcutSettings {
  const bindings = { ...DEFAULT_SHORTCUT_SETTINGS.bindings };
  if (value?.bindings && typeof value.bindings === "object") {
    for (const action of Object.keys(bindings) as ShortcutAction[]) {
      const candidate = value.bindings[action];
      if (typeof candidate === "string" && candidate.trim()) {
        bindings[action] = normalizeShortcutAccelerator(candidate);
      }
    }
  }
  return {
    revision:
      Number.isInteger(value?.revision) && Number(value?.revision) > 0
        ? Number(value?.revision)
        : DEFAULT_SHORTCUT_SETTINGS.revision,
    bindings,
  };
}

export function loadShortcutSettings(): ShortcutSettings {
  if (typeof localStorage === "undefined") {
    return structuredClone(DEFAULT_SHORTCUT_SETTINGS);
  }
  try {
    const raw = localStorage.getItem(SHORTCUT_SETTINGS_STORAGE_KEY);
    return normalizeShortcutSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return structuredClone(DEFAULT_SHORTCUT_SETTINGS);
  }
}

export function persistShortcutSettings(settings: ShortcutSettings) {
  validateShortcutSettings(settings);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(
      SHORTCUT_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizeShortcutSettings(settings))
    );
  }
}

export function shortcutBindings(settings: ShortcutSettings): ShortcutBinding[] {
  return (Object.keys(settings.bindings) as ShortcutAction[]).map((action) => ({
    action,
    accelerator: normalizeShortcutAccelerator(settings.bindings[action]),
  }));
}

type ShortcutHandler = (
  action: ShortcutAction,
  accelerator: string
) => void | Promise<void>;

export class GlobalShortcutRegistry {
  private bindings: ShortcutBinding[] = [];
  private operation: Promise<void> = Promise.resolve();

  replace(settings: ShortcutSettings, handler: ShortcutHandler) {
    const task = this.operation.then(() => this.replaceNow(settings, handler));
    this.operation = task.catch(() => undefined);
    return task;
  }

  clear() {
    const task = this.operation.then(() => this.clearNow());
    this.operation = task.catch(() => undefined);
    return task;
  }

  private async clearNow() {
    const previous = this.bindings;
    this.bindings = [];
    if (!isTauri() || previous.length === 0) return;
    const { unregister } = await import(
      "@tauri-apps/plugin-global-shortcut"
    );
    await unregister(previous.map((entry) => entry.accelerator)).catch(
      () => undefined
    );
  }

  private async replaceNow(
    settings: ShortcutSettings,
    handler: ShortcutHandler
  ) {
    validateShortcutSettings(settings);
    const next = shortcutBindings(settings);
    if (!isTauri()) {
      this.bindings = next;
      return;
    }

    const { register, unregister } = await import(
      "@tauri-apps/plugin-global-shortcut"
    );
    const previous = this.bindings;
    if (previous.length > 0) {
      await unregister(previous.map((entry) => entry.accelerator)).catch(
        () => undefined
      );
    }

    const registered: ShortcutBinding[] = [];
    try {
      for (const binding of next) {
        await register(binding.accelerator, (event) => {
          if (event.state === "Pressed") {
            void handler(binding.action, binding.accelerator);
          }
        });
        registered.push(binding);
      }
      this.bindings = next;
    } catch (error) {
      if (registered.length > 0) {
        await unregister(registered.map((entry) => entry.accelerator)).catch(
          () => undefined
        );
      }
      for (const binding of previous) {
        await register(binding.accelerator, (event) => {
          if (event.state === "Pressed") {
            void handler(binding.action, binding.accelerator);
          }
        }).catch(() => undefined);
      }
      this.bindings = previous;
      const failed = next[registered.length];
      const message = error instanceof Error ? error.message : String(error);
      const failure: ShortcutRegistrationFailure = {
        action: failed?.action ?? "toggle-visibility",
        accelerator: failed?.accelerator ?? "unknown",
        message,
      };
      throw new Error(
        `${SHORTCUT_ACTION_LABELS[failure.action]} could not register ${failure.accelerator}: ${failure.message}`
      );
    }
  }
}

export function isEditableElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}
