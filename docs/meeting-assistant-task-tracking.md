# Meeting Assistant Task Tracking

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs decision

## Current Phase

Phase 1: Meeting Assistant MVP implementation has resumed with screen-anchored technical question mode as the active workstream.

Current work has a validated audio-to-transcript-to-advice loop, explicit privacy modes, manual and hotkey-triggered active-window capture, and capture-target debug metadata. Recent testing showed that the earlier `screen-only` direction was too narrow for the real use case: screen content should be the anchor for technical questions, while meeting audio should act as clarification, modification, or follow-up context.

Current implementation status:

- Screenshot Auto prompt wiring, clarifying-question quick actions, and hallucination guards are retained.
- Explicit screen captures now create an `activeScreenTask` and produce structured screen-task answers directly from the vision provider.
- Later transcript turns use the active screen task as the anchor and update the technical answer as clarification or follow-up context arrives.
- Initial user testing reports the screen-anchored behavior is materially better than the previous generic screen-only path.
- The Meeting Assistant panel now has a fixed expanded width, wrapped long-response layout, and native cursor override while open.
- Remaining high-impact gaps are cursor-centered question focus selection, broader validation with mock meetings, and lifecycle controls such as manual task dismiss or timeout.

## Milestone 0: Design Review and Scope Lock

Goal: agree on MVP boundaries before touching production code.

- [x] Review existing Jarvis architecture.
- [x] Compare against external system design reports.
- [x] Choose Tauri/Jarvis as MVP base with native macOS migration path.
- [x] Write low-level design document.
- [x] Write task tracking document.
- [x] Review and approve MVP scope.
- [x] Decide first supported OS target.
- [x] Decide default STT provider strategy.
- [x] Decide default LLM provider strategy.
- [x] Decide transcript retention policy.
- [x] Decide whether microphone capture is included in v1.

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

- [x] Add Rust meeting audio command wrapper around existing system audio capture.
- [x] Add `MeetingAudioConfig` and `MeetingAudioStatus` types.
- [x] Reuse `speech-detected` event in meeting mode.
- [x] Convert base64 WAV event payload into browser `Blob`.
- [x] Route blob through `TranscriptionService`.
- [x] Normalize transcript into `TranscriptTurn`.
- [x] Append turns to `MeetingContextManager`.
- [x] Show latest transcript in temporary debug overlay.
- [x] Handle missing system audio permission.
- [x] Handle STT provider missing.
- [x] Handle STT timeout.

Exit criteria:

- User can toggle meeting audio capture.
- System audio speech appears as transcript text.
- No raw audio is persisted by default.
- Stopping capture reliably clears active capture state.

## Milestone 3: Advisor MVP

Goal: generate useful short suggestions from transcript context.

- [x] Implement advisor trigger on finalized `them` turn.
- [x] Add 500-1000 ms debounce.
- [x] Cancel stale in-flight advisor request on newer turn.
- [x] Build compact advisor prompt from latest transcript turns.
- [x] Reuse existing `fetchAIResponse` streaming path.
- [x] Parse output into `AdvisorSuggestion`.
- [x] Display streaming suggestions in overlay.
- [x] Add error state for missing AI provider.
- [x] Add manual "regenerate" action.
- [x] Add manual "make shorter" action if simple to support.

Exit criteria:

- After someone speaks in a meeting, the overlay shows a concise explanation or suggested reply.
- Newer turns replace stale suggestions.
- The overlay remains responsive during streaming.

## Milestone 4: Overlay UX

Goal: create a meeting-specific overlay that is useful under pressure.

- [x] Add meeting assistant UI components under `src/pages/app/components/meeting`.
- [x] Show capture/listening status.
- [x] Show latest transcript snippet.
- [x] Show "Meaning" section.
- [x] Show "Suggested reply" section.
- [x] Show "Clarifying question" section.
- [x] Add one-click clarifying-question feedback controls.
- [x] Add pause/resume control.
- [x] Add hide overlay control.
- [x] Ensure UI uses a fixed expanded width and wraps long responses instead of growing horizontally.
- [x] Restore native cursor behavior while the Meeting Assistant panel is open.
- [x] Avoid adding marketing/explanatory text inside the tool surface.
- [ ] Check small window and common laptop viewport layouts.

Exit criteria:

- Overlay can be used during a live meeting without opening dashboard.
- Text does not overlap or overflow in normal use.
- Controls are keyboard-friendly.

## Milestone 5: Screen Context MVP

Goal: provide visual context from screen sharing or shared pages.

- [x] Add hotkey-triggered active-window capture for meeting context.
- [x] Add manual overlay-triggered active-window capture for meeting context.
- [x] Preserve existing `capture_to_base64` for the separate manual screenshot path.
- [x] Add current-monitor fallback for active-window capture failure.
- [x] Add `ScreenObservation` to context manager.
- [x] Store capture target debug metadata on `ScreenObservation`.
- [x] Use monitor-crop active-window capture to handle Zoom/video host windows.
- [x] Show a capture preview thumbnail, capture method, image size, monitor, and top window candidates in debug metadata.
- [x] Reuse Screenshot Auto mode's auto prompt for Meeting Assistant screen analysis.
- [x] Add screen-only advisor mode to avoid inventing colleagues when a capture has no transcript.
- [x] Send screenshot to vision-capable provider only when triggered.
- [x] Include latest visual summary in advisor prompt.
- [x] Add setting to disable screen context entirely.
- [x] Avoid persisting screenshots by default.
- [x] Add screenshot hash metadata for future duplicate suppression and rate limiting.
- [x] Force a suggestion after manual or hotkey-triggered screen context, even when meeting audio is not actively listening.

Exit criteria:

- User can press a hotkey to explain the frontmost active window.
- Latest screen context improves subsequent suggestions.
- Screen context can be disabled independently from audio.

## Milestone 5A: Screen-Anchored Technical Question Mode

Goal: redesign screen context from generic screenshot explanation into a technical question solver where screen content is the primary task and audio is supplemental context.

- [x] Identify product mismatch in current `screen-only` approach.
- [x] Define target use case: Notepad, IDE, VSCode-like editor, or shared page containing a technical question.
- [x] Define audio role: clarification, modification, follow-up, or extra constraints for the visible screen question.
- [x] Decide whether to keep, revise, or revert the uncommitted `screen-only` prototype patch.
- [x] Update the low-level design after review to describe screen-anchored task state and event flow.
- [~] Define and implement `activeScreenTask` lifecycle:
  - starts on explicit screen capture.
  - stores visible question, task classification, relevant screenshot metadata, and recent audio context.
  - receives later transcript turns as clarification or follow-up.
  - currently ends on new meaningful capture or cleared non-question capture.
  - manual dismiss, stop-clear semantics, and timeout still need product validation.
- [x] Define screen task classification:
  - open field-knowledge question.
  - coding/algorithm question.
  - ambiguous or multiple-question screen.
  - non-question screen context.
- [x] Define answer contract for field-knowledge questions:
  - concise professional answer.
  - meeting-ready English wording.
  - optional short Chinese explanation only when helpful.
- [x] Define answer contract for coding questions:
  - default language: Python unless the screen specifies another language.
  - algorithm idea.
  - implementation.
  - time complexity.
  - space complexity.
  - explanation concise enough for live conversation.
- [ ] Define cursor/focus behavior:
  - record mouse position at capture time.
  - prioritize text or question near cursor when multiple questions or distractors are visible.
  - consider sending both focused crop and full active-window image.
- [x] Decide how Screenshot Auto prompt should interact with meeting mode:
  - recommended: treat it as user preference/instruction, not as the primary system contract.
  - it must not override technical-question output requirements.
- [x] Redesign Meeting Assistant output sections for screen tasks:
  - `Question`.
  - `Answer`.
  - `Approach`.
  - `Code`.
  - `Complexity`.
  - `Clarifying question`.
- [x] Define how quick clarifying controls apply to active screen tasks.
- [x] Update task priority after user review.
- [~] Validate quality in mock meetings with both field-knowledge and coding questions.
  - Initial user feedback on the new implementation is positive.
  - Broader scenario coverage is still needed before calling this complete.
- [ ] Add manual clear/dismiss for the active screen task if testing shows stale task carryover.

Exit criteria:

- Explicit capture returns a structured technical answer anchored to the active window.
- Later audio can update the same answer as clarification/follow-up context.
- Meeting UI supports screen-task sections and quick clarifying controls.
- Remaining focus/lifecycle hardening tasks are tracked separately.

## Milestone 6: Automatic Screen Observation

Goal: add low-frequency, low-noise visual awareness.

- [ ] Add optional observation interval setting.
- [ ] Capture at conservative default interval.
- [x] Add screenshot hash calculation.
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
- [~] Hide overlay during self-capture where possible.
- [ ] Add privacy mode setting:
  - [x] Local only placeholder.
  - [x] Text to cloud.
  - [x] Text and selected images to cloud.
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
| AI suggestions are too verbose | Medium | Strict advisor prompt, UI output limits, regenerate and shorter controls | Mitigating |
| Screen observation costs too much | Medium | Keep observation manual/hotkey-only, keep hash metadata, add duplicate suppression and rate limits before automatic mode | Mitigating |
| Existing inherited code is too coupled | Medium | Add meeting modules first, then refactor hooks | Open |
| Privacy expectations are unclear | High | Add explicit privacy mode and no raw persistence defaults | Mitigating |
| Screen and audio semantics are underspecified | High | Screen-anchored task model implemented; continue validating with mock meetings | Mitigating |
| Transparent overlay can hide the system cursor | Medium | Use native cursor while Meeting Assistant is expanded and hide the custom cursor layer | Mitigated |

## Decision Log

| Date | Decision | Notes |
|---|---|---|
| 2026-05-07 | Use forked desktop assistant as MVP base | Faster than rewriting, existing Tauri/Rust capture and overlay foundations are valuable |
| 2026-05-07 | Keep native macOS migration path open | SwiftUI/AppKit is likely the best production architecture for macOS-only long term |
| 2026-05-07 | Avoid absolute invisibility guarantee | Modern screen capture paths may still capture overlays |
| 2026-05-08 | Rebrand as Jarvis and pause commercial scope | Project is personal-use only; removed hosted API, telemetry, updater, license gates, promotional UI, and commercial README content |
| 2026-05-08 | Lock personal MVP defaults | macOS-only, BYOK/custom providers, in-memory transcripts, no v1 microphone capture, manual screen context first, no invisibility guarantee |
| 2026-05-09 | Make screen-context hotkey a one-shot advisor path | `Cmd+Shift+E` hides the meeting panel before capture, analyzes the current screen, then reopens the panel with guidance even when audio listening is not active |
| 2026-05-18 | Prefer active-window capture for meeting screen context | Meeting screen context no longer depends on the Jarvis overlay monitor; each observation records target app/window/bounds and active-window fallback reasons |
| 2026-05-18 | Capture active-window regions from the composed monitor image | Zoom can expose host windows such as `CptHost / ZOOM Sharing Frame Window`; monitor-crop capture should match the visible shared content more reliably than direct window capture |
| 2026-05-19 | Close the clarifying-question interaction loop | Clarifying questions now provide `Yes`, `No`, `Not sure`, and `Dismiss` actions; clicked answers feed the next advisor request without requiring typing |
| 2026-05-19 | Honor Screenshot Auto prompt in meeting screen analysis | Meeting screen context uses the configured screenshot auto prompt when Screenshot settings are in `Auto` mode |
| 2026-05-19 | Add screen-only advisor behavior | Temporary guard to stop screenshot-only requests from inventing colleagues, speakers, or meeting dialogue |
| 2026-05-19 | Pause implementation for screen/audio fusion design review | Real use case is screen-anchored technical Q&A with audio as supplemental clarification; task tracking is updated before further implementation |
| 2026-05-19 | Fix Meeting Assistant expanded layout | Long responses wrap inside a fixed-width panel; native window width is requested explicitly and clamped to the current monitor |
| 2026-05-19 | Use native cursor while Meeting Assistant is open | Avoid cursor loss caused by hidden/custom cursor styling over the enlarged transparent Tauri window |

## Validation Snapshot

Last validated: 2026-05-19.

- `npm run build` passes.
- `cargo check` passes after selecting full Xcode as the active developer directory.
- `git diff --check` passes before commits in the current phase.
- Manual screen-context test passes well enough for the next live-meeting smoke test.
- Manual Meeting Assistant layout and cursor tests passed after expanding the panel and overriding custom cursor behavior.

## Immediate Next Tasks

1. Continue mock-meeting validation with Zoom first, then Google Meet and Teams.
2. Add manual clear/dismiss for stale active screen tasks if testing shows task carryover.
3. Define cursor-centered question focus selection for screens with multiple questions or distractors.
4. Add duplicate-screenshot suppression and rate limiting before automatic observation mode.
