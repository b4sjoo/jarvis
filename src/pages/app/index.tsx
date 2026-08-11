import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AudioLines,
  BookOpenText,
  Command,
  FolderKanban,
  Headphones,
  History,
  PanelLeft,
  PictureInPicture2,
  Power,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { useCallingAssistant } from "@/hooks/useCallingAssistant";
import {
  SHORTCUT_SCHEME_VERSION,
  GlobalShortcutRegistry,
  MOSS_WINDOW_PROFILES,
  callStatusLabel,
  isEditableElement,
  isTauriRuntime,
  shortcutDisplayText,
  type MossInterfaceMode,
  type ShortcutAction,
} from "@/lib/calling";
import CallingPage from "@/pages/calling";
import AudioSettingsPage from "@/pages/audio";
import ModelSettingsPage from "@/pages/models";
import ShortcutReferencePage from "@/pages/shortcuts";
import SessionsPage from "@/pages/sessions";
import AppSettingsPage from "@/pages/settings";
import "./app.css";

type AppSection =
  | "call"
  | "cases"
  | "sessions"
  | "audio"
  | "shortcuts"
  | "models"
  | "settings";

const sections: Array<{
  id: AppSection;
  label: string;
  description: string;
  icon: typeof Headphones;
}> = [
  {
    id: "call",
    label: "Call",
    description: "Realtime transcript, guidance, and call controls.",
    icon: Headphones,
  },
  {
    id: "cases",
    label: "Cases",
    description: "Prepare evidence, goals, and plans before a call.",
    icon: FolderKanban,
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Review local recordings and guidance feedback.",
    icon: History,
  },
  {
    id: "audio",
    label: "Audio",
    description: "Choose devices and tune speech segmentation.",
    icon: AudioLines,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Reference the fixed controls available during a call.",
    icon: Command,
  },
  {
    id: "models",
    label: "Models",
    description: "Manage independent model routes and credentials.",
    icon: SlidersHorizontal,
  },
  {
    id: "settings",
    label: "App Settings",
    description: "Inspect privacy, storage, and window behavior.",
    icon: Settings,
  },
];

const closableStates = new Set([
  "starting",
  "live",
  "paused",
  "recovering",
  "start-failed",
]);

function Placeholder({
  section,
}: {
  section: "cases";
}) {
  const content: Record<typeof section, { title: string; body: string }> = {
    cases: {
      title: "Case Preparation is next",
      body: "Task 1 will build the case workspace here without changing the realtime call surface.",
    },
  };
  const selected = content[section];
  return (
    <section className="empty-route" aria-labelledby={`${section}-title`}>
      <BookOpenText size={24} />
      <h2 id={`${section}-title`}>{selected.title}</h2>
      <p>{selected.body}</p>
    </section>
  );
}

export default function MossApp() {
  const controller = useCallingAssistant();
  const [interfaceMode, setInterfaceMode] =
    useState<MossInterfaceMode>("control");
  const [activeSection, setActiveSection] = useState<AppSection>("call");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [shortcutRegistrationError, setShortcutRegistrationError] = useState<
    string | null
  >(null);
  const [lastShortcutAction, setLastShortcutAction] = useState<string | null>(
    null
  );
  const shortcutRegistryRef = useRef(new GlobalShortcutRegistry());
  const controllerRef = useRef(controller);
  const interfaceModeRef = useRef(interfaceMode);
  const shortcutHandlerRef = useRef<
    (action: ShortcutAction, accelerator: string) => Promise<void>
  >(async () => undefined);

  controllerRef.current = controller;
  interfaceModeRef.current = interfaceMode;

  const section = useMemo(
    () => sections.find((candidate) => candidate.id === activeSection) ?? sections[0],
    [activeSection]
  );

  const quit = useCallback(async () => {
    if (quitting) return;
    setQuitting(true);
    setQuitError(null);
    controller.recordInterfaceAction({
      action: "quit",
      source: "ui",
      outcome: "requested",
    });
    try {
      if (closableStates.has(controller.runtime.state)) {
        await controller.end();
      }
      if (controller.runtime.state === "close-failed") {
        throw new Error("Close the active recording before quitting MOSS.");
      }
      if (isTauriRuntime()) await invoke("exit_app");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      controller.recordInterfaceAction({
        action: "quit",
        source: "ui",
        outcome: "failed",
        detail,
      });
      setQuitError(detail);
    } finally {
      setQuitting(false);
    }
  }, [controller, quitting]);

  const applyInterfaceMode = useCallback(async (
    mode: MossInterfaceMode,
    source: "ui" | "shortcut" | "system" = "ui"
  ) => {
    const previousMode = interfaceModeRef.current;
    setWindowError(null);
    controllerRef.current.recordInterfaceAction({
      action: "switch-mode",
      source,
      outcome: "requested",
      detail: mode,
    });
    if (!isTauriRuntime()) {
      interfaceModeRef.current = mode;
      setInterfaceMode(mode);
      controllerRef.current.recordInterfaceAction({
        action: "switch-mode",
        source,
        outcome: "completed",
        detail: mode,
      });
      return;
    }
    try {
      const profile = MOSS_WINDOW_PROFILES[mode];
      const appWindow = getCurrentWindow();
      await appWindow.setMinSize(
        new LogicalSize(profile.minWidth, profile.minHeight)
      );
      await appWindow.setSize(new LogicalSize(profile.width, profile.height));
      await appWindow.setAlwaysOnTop(profile.alwaysOnTop);
      await appWindow.center();
      interfaceModeRef.current = mode;
      setInterfaceMode(mode);
      controllerRef.current.recordInterfaceAction({
        action: "switch-mode",
        source,
        outcome: "completed",
        detail: mode,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      interfaceModeRef.current = previousMode;
      controllerRef.current.recordInterfaceAction({
        action: "switch-mode",
        source,
        outcome: "failed",
        detail,
      });
      setWindowError(detail);
      throw error;
    }
  }, []);

  const hideMoss = useCallback(async () => {
    if (shortcutRegistrationError) {
      throw new Error("Resolve the global show/hide shortcut before hiding MOSS.");
    }
    controllerRef.current.recordInterfaceAction({
      action: "hide",
      source: "ui",
      outcome: "requested",
    });
    if (!isTauriRuntime()) return;
    try {
      await getCurrentWindow().hide();
      controllerRef.current.recordInterfaceAction({
        action: "hide",
        source: "ui",
        outcome: "completed",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      controllerRef.current.recordInterfaceAction({
        action: "hide",
        source: "ui",
        outcome: "failed",
        detail,
      });
      throw error;
    }
  }, [shortcutRegistrationError]);

  const executeShortcut = useCallback(
    async (action: ShortcutAction, accelerator: string) => {
      const activeController = controllerRef.current;
      const record = (
        outcome: "triggered" | "completed" | "ignored" | "failed",
        detail?: string
      ) =>
        activeController.recordShortcutAction({
          action,
          accelerator,
          outcome,
          detail,
          shortcutSchemeVersion: SHORTCUT_SCHEME_VERSION,
        });

      const protectsEditing = [
        "toggle-listening",
        "request-guidance",
        "end-call",
      ].includes(action);
      if (protectsEditing && isEditableElement(document.activeElement)) {
        const detail = "Ignored while editing text or settings.";
        setLastShortcutAction(detail);
        record("ignored", "editable-element-focused");
        return;
      }

      record("triggered");
      try {
        if (action === "toggle-visibility") {
          if (!isTauriRuntime()) return;
          const appWindow = getCurrentWindow();
          if (await appWindow.isVisible()) {
            await appWindow.hide();
          } else {
            await appWindow.show();
            await appWindow.setFocus();
          }
        } else if (action === "toggle-interface") {
          await applyInterfaceMode(
            interfaceModeRef.current === "control" ? "companion" : "control",
            "shortcut"
          );
        } else if (action === "toggle-listening") {
          const state = activeController.runtime.state;
          if (["planned", "closed", "start-failed", "abandoned"].includes(state)) {
            await activeController.start();
          } else if (state === "live") {
            await activeController.pause();
          } else if (["paused", "recovering"].includes(state)) {
            await activeController.resume();
          } else {
            throw new Error(`Listening cannot change while the call is ${state}.`);
          }
        } else if (action === "request-guidance") {
          const hasCounterpartyTurn = activeController.runtime.transcript.some(
            (turn) => turn.speaker === "them"
          );
          if (!hasCounterpartyTurn) {
            throw new Error("Guidance needs a counterparty turn first.");
          }
          if (!activeController.configured.advisor) {
            throw new Error("Configure the Advisor model before requesting guidance.");
          }
          await activeController.requestGuidance();
        } else if (action === "end-call") {
          if (!["live", "paused", "recovering", "start-failed"].includes(activeController.runtime.state)) {
            throw new Error("There is no active call to end.");
          }
          await activeController.end();
        }
        const detail = `${action} completed.`;
        setLastShortcutAction(detail);
        record("completed");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setLastShortcutAction(detail);
        record("failed", detail);
      }
    },
    [applyInterfaceMode]
  );

  shortcutHandlerRef.current = executeShortcut;

  useEffect(() => {
    let disposed = false;
    void shortcutRegistryRef.current
      .replace((action, accelerator) =>
        shortcutHandlerRef.current(action, accelerator)
      )
      .then(() => {
        if (!disposed) setShortcutRegistrationError(null);
      })
      .catch((error) => {
        if (!disposed) {
          setShortcutRegistrationError(
            error instanceof Error ? error.message : String(error)
          );
        }
      });
    return () => {
      disposed = true;
      void shortcutRegistryRef.current.clear();
    };
  }, []);

  useEffect(() => {
    void applyInterfaceMode("control", "system").catch(() => undefined);
  }, [applyInterfaceMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "q") {
        event.preventDefault();
        void quit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [quit]);

  if (interfaceMode === "companion") {
    return (
      <div className="companion-shell">
        {windowError && <div className="app-alert" role="alert">{windowError}</div>}
        <CallingPage
          controller={controller}
          onOpenControlCenter={() => void applyInterfaceMode("control").catch(() => undefined)}
        />
      </div>
    );
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="app-sidebar">
        <div className="app-identity" data-tauri-drag-region>
          <span className="app-mark"><Headphones size={18} /></span>
          {!sidebarCollapsed && <span><strong>MOSS</strong><small>Calling Helper</small></span>}
        </div>

        <nav aria-label="MOSS sections">
          {sections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={activeSection === item.id ? "nav-item nav-item-active" : "nav-item"}
                onClick={() => setActiveSection(item.id)}
                title={sidebarCollapsed ? item.label : undefined}
                aria-current={activeSection === item.id ? "page" : undefined}
              >
                <Icon size={17} />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            className="nav-item quit-item"
            onClick={() => void quit()}
            disabled={quitting}
            title={sidebarCollapsed ? "Quit MOSS" : undefined}
          >
            <Power size={17} />
            {!sidebarCollapsed && <span>{quitting ? "Closing call..." : "Quit MOSS"}</span>}
          </button>
        </div>
      </aside>

      <section className="app-workspace">
        <header className="workspace-header">
          <button
            className="icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <PanelLeft size={18} />
          </button>
          <div data-tauri-drag-region>
            <h1>{section.label}</h1>
            <p>{section.description}</p>
          </div>
          <div className={`workspace-call-state state-${controller.runtime.state}`}>
            <span />
            {callStatusLabel(controller.runtime.state)}
          </div>
          {activeSection === "call" && (
            <button
              className="secondary-button workspace-companion-button"
              onClick={() => void applyInterfaceMode("companion").catch(() => undefined)}
            >
              <PictureInPicture2 size={16} />
              Live companion
            </button>
          )}
        </header>

        {(quitError || windowError) && <div className="app-alert" role="alert">{quitError ?? windowError}</div>}

        <main className={activeSection === "call" ? "workspace-content call-route" : "workspace-content"}>
          {activeSection === "call" ? (
            <CallingPage controller={controller} embedded />
          ) : activeSection === "audio" ? (
            <AudioSettingsPage controller={controller} />
          ) : activeSection === "models" ? (
            <ModelSettingsPage controller={controller} />
          ) : activeSection === "shortcuts" ? (
            <ShortcutReferencePage
              registrationError={shortcutRegistrationError}
              lastAction={lastShortcutAction}
            />
          ) : activeSection === "sessions" ? (
            <SessionsPage controller={controller} />
          ) : activeSection === "settings" ? (
            <AppSettingsPage
              interfaceMode={interfaceMode}
              nativeRuntimeAvailable={controller.nativeRuntimeAvailable}
              visibilityShortcut={shortcutDisplayText("toggle-visibility")}
              onSwitchMode={(mode) => applyInterfaceMode(mode)}
              onHide={hideMoss}
            />
          ) : (
            <Placeholder section={activeSection} />
          )}
        </main>

        <footer className="app-statusbar">
          <span>Local-first runtime ready</span>
          <span>
            {controller.recordingStatus
              ? `${controller.recordingStatus.callSessionId} · ${controller.recordingStatus.eventCount} events · ${controller.recordingStatus.state}`
              : "No active recording"}
          </span>
        </footer>
      </section>
    </div>
  );
}
