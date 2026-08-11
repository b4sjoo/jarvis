import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AudioLines,
  BookOpenText,
  Command,
  FolderKanban,
  Headphones,
  History,
  PanelLeft,
  Power,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { useCallingAssistant } from "@/hooks/useCallingAssistant";
import CallingPage from "@/pages/calling";
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
    description: "Configure fast, reliable call controls.",
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

const isTauri = () => "__TAURI_INTERNALS__" in window;

function Placeholder({
  section,
}: {
  section: Exclude<AppSection, "call">;
}) {
  const content: Record<typeof section, { title: string; body: string }> = {
    cases: {
      title: "Case Preparation is next",
      body: "Task 1 will build the case workspace here without changing the realtime call surface.",
    },
    sessions: {
      title: "Session history is local",
      body: "Recording discovery, recovery, and export will move into this route in Task 2E.",
    },
    audio: {
      title: "Audio controls are coming back",
      body: "Task 2C will restore device selection, safe presets, and advanced speech segmentation controls.",
    },
    shortcuts: {
      title: "One command path",
      body: "Task 2D will register shortcuts that invoke the same runtime commands as visible controls.",
    },
    models: {
      title: "Independent model routes",
      body: "Runtime, Advisor, Complex Task, and Speech-to-Text settings will live here in Task 2D.",
    },
    settings: {
      title: "Application controls",
      body: "Privacy, local storage, version, and window behavior will remain separate from realtime guidance.",
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
  const [activeSection, setActiveSection] = useState<AppSection>("call");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);
  const [quitting, setQuitting] = useState(false);

  const section = useMemo(
    () => sections.find((candidate) => candidate.id === activeSection) ?? sections[0],
    [activeSection]
  );

  const quit = useCallback(async () => {
    if (quitting) return;
    setQuitting(true);
    setQuitError(null);
    try {
      if (closableStates.has(controller.runtime.state)) {
        await controller.end();
      }
      if (controller.runtime.state === "close-failed") {
        throw new Error("Close the active recording before quitting MOSS.");
      }
      if (isTauri()) await invoke("exit_app");
    } catch (error) {
      setQuitError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuitting(false);
    }
  }, [controller, quitting]);

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
        <header className="workspace-header" data-tauri-drag-region>
          <button
            className="icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <PanelLeft size={18} />
          </button>
          <div>
            <h1>{section.label}</h1>
            <p>{section.description}</p>
          </div>
          <div className={`workspace-call-state state-${controller.runtime.state}`}>
            <span />
            {controller.runtime.state}
          </div>
        </header>

        {quitError && <div className="app-alert" role="alert">{quitError}</div>}

        <main className={activeSection === "call" ? "workspace-content call-route" : "workspace-content"}>
          {activeSection === "call" ? (
            <CallingPage controller={controller} embedded />
          ) : (
            <Placeholder section={activeSection} />
          )}
        </main>

        <footer className="app-statusbar">
          <span>Local-first runtime ready</span>
          <span>{controller.recordingStatus ? `Recording ${controller.recordingStatus.state}` : "No active recording"}</span>
        </footer>
      </section>
    </div>
  );
}
