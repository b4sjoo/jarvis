# Jarvis

Jarvis is a personal desktop meeting assistant adapted from an upstream desktop assistant codebase for private use.

The current goal is narrow: help me understand software engineering meetings faster by combining system audio transcription, screen/screenshot context, and concise AI suggestions. This repository is not a commercial product, has no subscription flow, and does not ship a hosted Jarvis API.

## Current Milestone

- Tauri + React desktop shell is running.
- Screen-share-safe overlay behavior is inherited from the original app foundation.
- Meeting assistant modules have been added for transcript context, screen observations, prompt construction, and advisor suggestions.
- The meeting overlay opens in the desktop app, supports explicit `Text+Screen` privacy mode, and can generate screen-context suggestions from the meeting hotkey.
- Explicit screen captures now produce screen-anchored technical answers with `Question`, `Answer`, `Approach`, `Code`, `Complexity`, and `Clarifying question` sections.
- Initial personal testing shows the screen-anchored flow is more useful than the earlier generic screen explanation path.

## Personal-Use Scope

Jarvis is currently designed for local personal use only.

- Bring your own AI and speech-to-text providers through the existing custom curl provider flow.
- No bundled paid license system.
- No usage analytics or telemetry.
- No hosted update endpoint.
- No public download, marketing, referral, bounty, or support flow.

## Architecture Notes

The app uses:

- `src/` for the React frontend, hooks, provider configuration, and assistant UI.
- `src-tauri/` for the native shell, global shortcuts, window behavior, capture, audio capture, and local database.
- `docs/meeting-assistant-low-level-design.md` for the low-level meeting assistant design.
- `docs/meeting-assistant-task-tracking.md` for task status and decision tracking.

## Development

Install dependencies:

```bash
npm install
```

Run the browser preview:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run tauri dev
```

Build the frontend:

```bash
npm run build
```

Check the Rust side:

```bash
cd src-tauri
cargo check
```

## Configuration

Jarvis expects you to configure local/custom providers before relying on meeting transcription or AI responses.

- AI providers are configured from curl commands with variables such as `{{TEXT}}`, `{{SYSTEM_PROMPT}}`, and optionally `{{IMAGE}}`.
- Speech providers are configured from curl commands that accept uploaded audio.
- System prompts and assistant behavior can be edited in the dashboard.

## Meeting Assistant Usage

- Open the floating Brain button to show the Meeting Assistant panel.
- Use the panel's Privacy selector to switch between `Text` and `Text+Screen`.
- `Cmd+Shift+E` captures the frontmost active window for meeting context, briefly hides the panel before capture, then reopens the panel with the generated suggestion.
- Screen capture is treated as the primary technical question source; recent meeting audio is used as clarification or follow-up context.
- The Meeting Assistant panel uses a fixed expanded width and wraps long answers vertically so responses do not push the window wider during a meeting.
- While the Meeting Assistant panel is open, Jarvis uses the native system cursor instead of its hidden/custom cursor mode to avoid cursor loss when moving across the transparent overlay area.
- Use `Clear task` when a screen question is no longer relevant. Screen tasks expire after the configured task memory window, which defaults to 30 minutes.
- `Cmd+\` is the emergency hide/show shortcut. Hiding collapses the Meeting Assistant UI without stopping meeting audio capture.
- The Meeting Assistant panel shows a compact `Last capture` debug row with a preview thumbnail, captured app/window, capture method, image size, bounds, and top window candidates.
- When Screenshot settings are in `Auto` mode, Meeting Assistant screen analysis treats the configured screenshot auto prompt as user preference while preserving the screen-task answer format.
- Clarifying questions include quick `Yes`, `No`, `Not sure`, and `Dismiss` controls so you can steer follow-up suggestions without typing during a meeting.
- `Cmd+Shift+S` remains the separate manual screenshot/completion shortcut.

## Privacy

Jarvis should only send data to providers you configure yourself. Be careful with meeting audio, screenshots, private code, and confidential company material. Review your provider terms and workplace policies before using it in real meetings.

## Origin

This is a private fork of an upstream desktop assistant project. The fork is being reshaped into Jarvis for personal workflow support, not for redistribution or commercial use.
