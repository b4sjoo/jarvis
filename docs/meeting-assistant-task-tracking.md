# Meeting Assistant Task Tracking

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs decision

## Current Phase

Phase 0: Design and implementation preparation.

No application code changes have been made for the meeting assistant feature yet. This document tracks planned implementation work after low-level design review.

## Milestone 0: Design Review and Scope Lock

Goal: agree on MVP boundaries before touching production code.

- [x] Review existing Jarvis architecture.
- [x] Compare against external system design reports.
- [x] Choose Tauri/Jarvis as MVP base with native macOS migration path.
- [x] Write low-level design document.
- [x] Write task tracking document.
- [ ] Review and approve MVP scope.
- [ ] Decide first supported OS target.
- [ ] Decide default STT provider strategy.
- [ ] Decide default LLM provider strategy.
- [ ] Decide transcript retention policy.
- [ ] Decide whether microphone capture is included in v1.

Exit criteria:

- LLD approved.
- MVP feature list approved.
- Provider and privacy defaults agreed.

## Milestone 1: Meeting Module Skeleton

Goal: add clean feature boundaries without changing existing behavior.

- [x] Create `src/lib/meeting/types.ts`.
- [x] Create `src/lib/meeting/context-manager.ts`.
- [x] Create `src/lib/meeting/advisor-prompt.ts`.
- [x] Create `src/lib/meeting/advisor-engine.ts`.
- [x] Create `src/lib/meeting/transcription.service.ts`.
- [x] Create `src/lib/meeting/screen-observation.service.ts`.
- [x] Create `src/hooks/useMeetingAssistant.ts`.
- [x] Add barrel exports where consistent with repo style.
- [ ] Add basic unit tests for pure TypeScript meeting logic if test setup is available.

Exit criteria:

- New modules compile.
- Existing app behavior remains unchanged.
- Meeting assistant code can be enabled behind a local feature flag.

## Milestone 2: Audio Session MVP

Goal: turn existing system audio capture into meeting transcript input.

- [ ] Add Rust meeting audio command wrapper around existing system audio capture.
- [ ] Add `MeetingAudioConfig` and `MeetingAudioStatus` types.
- [x] Reuse `speech-detected` event in meeting mode.
- [x] Convert base64 WAV event payload into browser `Blob`.
- [x] Route blob through `TranscriptionService`.
- [x] Normalize transcript into `TranscriptTurn`.
- [x] Append turns to `MeetingContextManager`.
- [ ] Show latest transcript in temporary debug overlay.
- [ ] Handle missing system audio permission.
- [x] Handle STT provider missing.
- [ ] Handle STT timeout.

Exit criteria:

- User can toggle meeting audio capture.
- System audio speech appears as transcript text.
- No raw audio is persisted by default.
- Stopping capture reliably clears active capture state.

## Milestone 3: Advisor MVP

Goal: generate useful short suggestions from transcript context.

- [x] Implement advisor trigger on finalized `them` turn.
- [ ] Add 500-1000 ms debounce.
- [x] Cancel stale in-flight advisor request on newer turn.
- [x] Build compact advisor prompt from latest transcript turns.
- [x] Reuse existing `fetchAIResponse` streaming path.
- [x] Parse output into `AdvisorSuggestion`.
- [ ] Display streaming suggestions in overlay.
- [ ] Add error state for missing AI provider.
- [ ] Add manual "regenerate" action.
- [ ] Add manual "make shorter" action if simple to support.

Exit criteria:

- After someone speaks in a meeting, the overlay shows a concise explanation or suggested reply.
- Newer turns replace stale suggestions.
- The overlay remains responsive during streaming.

## Milestone 4: Overlay UX

Goal: create a meeting-specific overlay that is useful under pressure.

- [x] Add meeting assistant UI components under `src/pages/app/components/meeting`.
- [x] Show capture/listening status.
- [x] Show latest transcript snippet.
- [ ] Show "Meaning" section.
- [x] Show "Suggested reply" section.
- [ ] Show "Clarifying question" section.
- [ ] Add pause/resume control.
- [x] Add hide overlay control.
- [x] Ensure UI fits inside existing overlay window dimensions.
- [x] Avoid adding marketing/explanatory text inside the tool surface.
- [ ] Check small window and common laptop viewport layouts.

Exit criteria:

- Overlay can be used during a live meeting without opening dashboard.
- Text does not overlap or overflow in normal use.
- Controls are keyboard-friendly.

## Milestone 5: Screen Context MVP

Goal: provide visual context from screen sharing or shared pages.

- [ ] Add hotkey-triggered current-screen capture for meeting context.
- [ ] Reuse existing `capture_to_base64`.
- [ ] Add `ScreenObservation` to context manager.
- [ ] Send screenshot to vision-capable provider only when triggered.
- [ ] Include latest visual summary in advisor prompt.
- [ ] Add setting to disable screen context entirely.
- [ ] Avoid persisting screenshots by default.
- [ ] Add simple duplicate suppression if same screenshot is captured repeatedly.

Exit criteria:

- User can press a hotkey to explain current screen.
- Latest screen context improves subsequent suggestions.
- Screen context can be disabled independently from audio.

## Milestone 6: Automatic Screen Observation

Goal: add low-frequency, low-noise visual awareness.

- [ ] Add optional observation interval setting.
- [ ] Capture at conservative default interval.
- [ ] Add screenshot hash calculation.
- [ ] Skip analysis when image hash is unchanged.
- [ ] Add rough rate limit for vision calls.
- [ ] Add "analyze now" override.
- [ ] Add UI indicator when screen context is active.

Exit criteria:

- Automatic screen context works without flooding model calls.
- User can tell when screen observation is enabled.
- No screenshots are saved unless user explicitly enables saving.

## Milestone 7: Privacy and Visibility Hardening

Goal: make limits explicit and prevent accidental data exposure.

- [ ] Add product copy that avoids "guaranteed invisible" claims.
- [ ] Add visibility caveat in onboarding/settings.
- [ ] Add one-tap hide shortcut.
- [ ] Hide overlay during self-capture where possible.
- [ ] Add privacy mode setting:
  - [ ] Local only placeholder.
  - [ ] Text to cloud.
  - [ ] Text and selected images to cloud.
- [ ] Add raw audio persistence guard.
- [ ] Add screenshot persistence guard.
- [x] Remove analytics, hosted API, updater, license gates, and commercial UI from Jarvis.

Exit criteria:

- User understands visibility limits.
- Meeting mode does not persist raw audio/screenshots by default.
- Cloud upload behavior is explicit.

## Milestone 8: Provider Improvements

Goal: improve real-time quality beyond current request/response STT.

- [ ] Design streaming STT provider interface.
- [ ] Add partial/final transcript model.
- [ ] Evaluate cloud streaming STT candidates.
- [ ] Add provider-specific endpointing support where available.
- [ ] Add local STT spike task.
- [ ] Add local OCR spike task.
- [ ] Add local LLM spike task.

Exit criteria:

- A clear provider roadmap exists.
- MVP provider choices can be swapped without rewriting meeting context.

## Milestone 9: Native macOS Spike

Goal: verify whether a SwiftUI/AppKit production path is worth migration.

- [ ] Create separate experimental native macOS project or branch.
- [ ] Implement minimal `NSPanel` overlay.
- [ ] Implement minimal Core Audio tap capture.
- [ ] Implement minimal ScreenCaptureKit capture.
- [ ] Implement minimal Apple Vision OCR.
- [ ] Compare latency and reliability against Tauri path.
- [ ] Decide whether to stay Tauri or migrate production shell.

Exit criteria:

- Native spike captures audio and screen reliably.
- Decision record written with evidence.

## Milestone 10: QA and Release Readiness

Goal: validate real meeting behavior.

- [ ] Test Zoom.
- [ ] Test Google Meet.
- [ ] Test Microsoft Teams.
- [ ] Test full-screen sharing.
- [ ] Test single-window sharing.
- [ ] Test second monitor usage.
- [ ] Test AirPods.
- [ ] Test built-in speakers.
- [ ] Test external display.
- [ ] Test permission denial and recovery.
- [ ] Test 60-minute session stability.
- [ ] Measure transcript latency.
- [ ] Measure suggestion latency.
- [ ] Measure CPU and memory.

Exit criteria:

- Known limitations documented.
- MVP is stable enough for personal daily use.

## Risk Register

| Risk | Impact | Mitigation | Status |
|---|---|---|---|
| Overlay appears during some screen sharing modes | High | Avoid absolute invisibility claims, add hide shortcut, recommend window sharing/second display | Open |
| System audio capture fails on some macOS/device combinations | High | Keep fallback path, improve permission and device handling | Open |
| STT latency too high | High | Add streaming STT provider interface | Open |
| AI suggestions are too verbose | Medium | Strict advisor prompt and UI output limits | Open |
| Screen observation costs too much | Medium | Add hash/diff/rate limit, default to manual hotkey | Open |
| Existing inherited code is too coupled | Medium | Add meeting modules first, then refactor hooks | Open |
| Privacy expectations are unclear | High | Add explicit privacy mode and no raw persistence defaults | Open |

## Decision Log

| Date | Decision | Notes |
|---|---|---|
| 2026-05-07 | Use forked desktop assistant as MVP base | Faster than rewriting, existing Tauri/Rust capture and overlay foundations are valuable |
| 2026-05-07 | Keep native macOS migration path open | SwiftUI/AppKit is likely the best production architecture for macOS-only long term |
| 2026-05-07 | Avoid absolute invisibility guarantee | Modern screen capture paths may still capture overlays |
| 2026-05-08 | Rebrand as Jarvis and pause commercial scope | Project is personal-use only; removed hosted API, telemetry, updater, license gates, promotional UI, and commercial README content |

## Immediate Next Tasks After Review

1. Confirm MVP feature boundary.
2. Confirm provider defaults.
3. Create meeting type definitions.
4. Create pure TypeScript context manager.
5. Wire existing system audio events into meeting transcript flow.
