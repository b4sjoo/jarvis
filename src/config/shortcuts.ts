import { ShortcutAction } from "@/types";

export const DEFAULT_SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "toggle_dashboard",
    name: "Toggle Dashboard",
    description: "Open/Close the dashboard window",
    defaultKey: {
      macos: "cmd+shift+d",
      windows: "ctrl+shift+d",
      linux: "ctrl+shift+d",
    },
  },
  {
    id: "toggle_window",
    name: "Toggle Window",
    description: "Show/Hide the main window",
    defaultKey: {
      macos: "cmd+backslash",
      windows: "ctrl+backslash",
      linux: "ctrl+backslash",
    },
  },
  {
    id: "focus_input",
    name: "Refocus Input Box",
    description: "Bring Jarvis forward and place the cursor in the input area",
    defaultKey: {
      macos: "cmd+shift+i",
      windows: "ctrl+shift+i",
      linux: "ctrl+shift+i",
    },
  },
  {
    id: "move_window",
    name: "Move Window",
    description: "Move overlay with arrow keys (hold to move continuously)",
    defaultKey: {
      macos: "cmd",
      windows: "ctrl",
      linux: "ctrl",
    },
  },
  {
    id: "meeting_screen_context",
    name: "Meeting Screen Context",
    description: "Capture current screen context for the meeting assistant",
    defaultKey: {
      macos: "cmd+shift+e",
      windows: "ctrl+shift+e",
      linux: "ctrl+shift+e",
    },
  },
  {
    id: "meeting_focus_mode",
    name: "Meeting Focus Mode",
    description: "Toggle Focus Mode for the meeting assistant",
    defaultKey: {
      macos: "cmd+shift+j",
      windows: "ctrl+shift+j",
      linux: "ctrl+shift+j",
    },
  },
  {
    id: "meeting_toggle_listening",
    name: "Meeting Toggle Listening",
    description: "Start, pause, or resume Meeting Assistant listening",
    defaultKey: {
      macos: "cmd+shift+l",
      windows: "ctrl+shift+l",
      linux: "ctrl+shift+l",
    },
  },
  {
    id: "meeting_regenerate",
    name: "Meeting Regenerate",
    description: "Regenerate the current Meeting Assistant suggestion",
    defaultKey: {
      macos: "cmd+shift+u",
      windows: "ctrl+shift+u",
      linux: "ctrl+shift+u",
    },
  },
  {
    id: "meeting_toggle_advise_pin",
    name: "Meeting Lock Advise",
    description: "Lock or unlock the displayed Advise",
    defaultKey: { macos: "cmd+shift+s", windows: "ctrl+shift+s", linux: "ctrl+shift+s" },
  },
  {
    id: "meeting_regenerate_artifacts",
    name: "Meeting Regenerate Artifacts",
    description: "Regenerate the current phase-owned meeting artifacts",
    defaultKey: {
      macos: "cmd+shift+a",
      windows: "ctrl+shift+a",
      linux: "ctrl+shift+a",
    },
  },
  {
    id: "meeting_enhance_context",
    name: "Meeting Enhance Context",
    description:
      "Regenerate with the smallest useful source context around the current question",
    defaultKey: {
      macos: "cmd+shift+up",
      windows: "ctrl+shift+up",
      linux: "ctrl+shift+up",
    },
  },
  {
    id: "meeting_narrow_context",
    name: "Meeting Narrow Context",
    description: "Regenerate from only the current source-owned question",
    defaultKey: {
      macos: "cmd+shift+down",
      windows: "ctrl+shift+down",
      linux: "ctrl+shift+down",
    },
  },
  {
    id: "meeting_previous_phase",
    name: "Meeting Previous Phase",
    description:
      "Return the current Meeting Assistant task to its previous playbook phase",
    defaultKey: {
      macos: "cmd+shift+left",
      windows: "ctrl+shift+left",
      linux: "ctrl+shift+left",
    },
  },
  {
    id: "meeting_next_phase",
    name: "Meeting Next Phase",
    description:
      "Advance the current Meeting Assistant task to the next playbook phase",
    defaultKey: {
      macos: "cmd+shift+right",
      windows: "ctrl+shift+right",
      linux: "ctrl+shift+right",
    },
  },
  {
    id: "meeting_toggle_microphone_context",
    name: "Meeting Mic Context",
    description: "Toggle microphone-side context capture for Meeting Assistant",
    defaultKey: {
      macos: "cmd+shift+v",
      windows: "ctrl+shift+v",
      linux: "ctrl+shift+v",
    },
  },
];
