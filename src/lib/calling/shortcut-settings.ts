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

export interface ShortcutDefinition extends ShortcutBinding {
  label: string;
  description: string;
}

export interface ShortcutRegistrationFailure {
  action: ShortcutAction;
  accelerator: string;
  message: string;
}

export type ShortcutDisplayPlatform = "macos" | "other";

export const SHORTCUT_SCHEME_VERSION = 1;

export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  "toggle-visibility": "Show or hide MOSS",
  "toggle-interface": "Switch control and companion",
  "toggle-listening": "Start, pause, or resume listening",
  "request-guidance": "Request guidance",
  "end-call": "End current call",
};

export const FIXED_SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    action: "toggle-visibility",
    accelerator: "CommandOrControl+Shift+M",
    label: SHORTCUT_ACTION_LABELS["toggle-visibility"],
    description: "Restore MOSS after hiding its window.",
  },
  {
    action: "toggle-interface",
    accelerator: "CommandOrControl+Shift+L",
    label: SHORTCUT_ACTION_LABELS["toggle-interface"],
    description: "Move between configuration and the live companion.",
  },
  {
    action: "toggle-listening",
    accelerator: "CommandOrControl+Shift+P",
    label: SHORTCUT_ACTION_LABELS["toggle-listening"],
    description: "Start a call or pause and resume active listening.",
  },
  {
    action: "request-guidance",
    accelerator: "CommandOrControl+Shift+A",
    label: SHORTCUT_ACTION_LABELS["request-guidance"],
    description: "Ask the Advisor to respond to the latest counterparty turn.",
  },
  {
    action: "end-call",
    accelerator: "CommandOrControl+Shift+E",
    label: SHORTCUT_ACTION_LABELS["end-call"],
    description: "Drain capture and close the current call recording.",
  },
];

const fixedActions: readonly ShortcutAction[] = [
  "toggle-visibility",
  "toggle-interface",
  "toggle-listening",
  "request-guidance",
  "end-call",
];

const shortcutPattern = /^CommandOrControl\+Shift\+[A-Z0-9]$/;

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function validateFixedShortcutDefinitions(
  definitions: readonly ShortcutDefinition[] = FIXED_SHORTCUT_DEFINITIONS
) {
  const seenActions = new Set<ShortcutAction>();
  const seenAccelerators = new Map<string, ShortcutAction>();

  for (const definition of definitions) {
    if (!fixedActions.includes(definition.action)) {
      throw new Error(`Unknown fixed shortcut action: ${definition.action}.`);
    }
    if (seenActions.has(definition.action)) {
      throw new Error(`${definition.label} is defined more than once.`);
    }
    if (!shortcutPattern.test(definition.accelerator)) {
      throw new Error(
        `${definition.label} has an invalid fixed shortcut: ${definition.accelerator}.`
      );
    }

    const canonical = definition.accelerator.toLowerCase();
    const existing = seenAccelerators.get(canonical);
    if (existing) {
      throw new Error(
        `${definition.label} conflicts with ${SHORTCUT_ACTION_LABELS[existing]}.`
      );
    }
    seenActions.add(definition.action);
    seenAccelerators.set(canonical, definition.action);
  }

  const missing = fixedActions.filter((action) => !seenActions.has(action));
  if (missing.length > 0) {
    throw new Error(`Missing fixed shortcuts: ${missing.join(", ")}.`);
  }
}

export function fixedShortcutBindings(): ShortcutBinding[] {
  validateFixedShortcutDefinitions();
  return FIXED_SHORTCUT_DEFINITIONS.map(({ action, accelerator }) => ({
    action,
    accelerator,
  }));
}

export function fixedShortcutDefinition(action: ShortcutAction) {
  const definition = FIXED_SHORTCUT_DEFINITIONS.find(
    (candidate) => candidate.action === action
  );
  if (!definition) {
    throw new Error(`Missing fixed shortcut definition for ${action}.`);
  }
  return definition;
}

export function detectShortcutDisplayPlatform(): ShortcutDisplayPlatform {
  if (typeof navigator === "undefined") return "other";
  return /mac/i.test(navigator.platform) ? "macos" : "other";
}

export function shortcutDisplayParts(
  action: ShortcutAction,
  platform: ShortcutDisplayPlatform = detectShortcutDisplayPlatform()
) {
  const definition = fixedShortcutDefinition(action);
  return definition.accelerator.split("+").map((part) => {
    if (part === "CommandOrControl") {
      return platform === "macos" ? "⌘" : "Ctrl";
    }
    if (part === "Shift") {
      return platform === "macos" ? "⇧" : "Shift";
    }
    return part;
  });
}

export function shortcutDisplayText(
  action: ShortcutAction,
  platform: ShortcutDisplayPlatform = detectShortcutDisplayPlatform()
) {
  return shortcutDisplayParts(action, platform).join(" ");
}

type ShortcutHandler = (
  action: ShortcutAction,
  accelerator: string
) => void | Promise<void>;

export class GlobalShortcutRegistry {
  private bindings: ShortcutBinding[] = [];
  private operation: Promise<void> = Promise.resolve();

  replace(handler: ShortcutHandler) {
    const task = this.operation.then(() => this.replaceNow(handler));
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

  private async replaceNow(handler: ShortcutHandler) {
    const next = fixedShortcutBindings();
    if (!isTauri()) {
      this.bindings = next;
      return;
    }

    const { isRegistered, register, unregister } = await import(
      "@tauri-apps/plugin-global-shortcut"
    );
    const previous = this.bindings;
    if (previous.length > 0) {
      await unregister(previous.map((entry) => entry.accelerator)).catch(
        () => undefined
      );
    }

    const registered: ShortcutBinding[] = [];
    let failedBinding: ShortcutBinding | undefined;
    try {
      for (const binding of next) {
        failedBinding = binding;
        await register(binding.accelerator, (event) => {
          if (event.state === "Pressed") {
            void handler(binding.action, binding.accelerator);
          }
        });
        registered.push(binding);
      }
      for (const binding of next) {
        failedBinding = binding;
        if (!(await isRegistered(binding.accelerator))) {
          throw new Error("The native shortcut registry did not confirm it.");
        }
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
      const message = error instanceof Error ? error.message : String(error);
      const failure: ShortcutRegistrationFailure = {
        action: failedBinding?.action ?? "toggle-visibility",
        accelerator: failedBinding?.accelerator ?? "unknown",
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

validateFixedShortcutDefinitions();
