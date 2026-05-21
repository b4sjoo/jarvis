# Meeting Assistant Task Tracking

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs decision

## Current Phase

Phase 2: Meeting Assistant MVP is usable after self-testing and informal meeting testing. The active workstream is now performance and UX tuning.

Current work has a validated audio-to-transcript-to-advice loop, explicit privacy modes, manual and hotkey-triggered active-window capture, capture-target debug metadata, a usable screen-anchored technical question flow, active task lifecycle controls, and a reliable emergency hide path.

Current implementation status:

- Screenshot Auto prompt wiring, clarifying-question quick actions, and hallucination guards are retained.
- Explicit screen captures now create an `activeScreenTask` and produce structured screen-task answers directly from the vision provider.
- Later transcript turns use the active screen task as the anchor and update the technical answer as clarification or follow-up context arrives.
- Initial user testing reports the screen-anchored behavior is materially better than the previous generic screen-only path.
- The Meeting Assistant panel now has a fixed expanded width, wrapped long-response layout, and native cursor override while open.
- Active screen tasks can be manually cleared, are cleared on stop, and expire after a configurable inactivity window that defaults to 30 minutes.
- The existing hide/show shortcut now acts as an emergency hide path that collapses the Meeting Assistant UI without stopping meeting audio capture.
- Observability work has started with in-memory screen and voice workflow traces in the Meeting Assistant panel.
- User validation confirms the active task lifecycle and emergency hide workflow are usable enough to move into tuning.
- Cursor/focus-aware question and language selection has completed its first tuning pass; performance baselines and screen/voice fusion hardening remain in the tuning backlog.
- The tuning backlog is expanded in `docs/optimization-roadmap.md` so review can happen one optimization at a time before implementation.
- Brainwave has been reviewed as a voice-pipeline reference. Its main lesson is to keep transcription literal, language-preserving, and non-answering while leaving task reasoning inside the Meeting Assistant advisor/context layer.
- Prompt-level interview task fusion has completed its first implementation slice: screen-seeded follow-ups, voice-only technical questions, explicit task-switch confirmation, low-signal speech filtering, stable speech listener registration, cancelled advisor tracing, and longer sanitized metrics history are now in code.
- Task memory expiration is rolling. Meaningful screen-task updates refresh `expiresAt`; low-signal ignored speech does not; changing the timeout setting recalculates expiry from the current time; manual clear or `New task` clears the active task.
- Structured screen answer state has completed its first implementation slice: screen-task output is parsed in `src/lib/meeting`, completed suggestions can carry parsed sections, partial streaming output is parsed on demand, and Debug Mode can inspect parsed screen-answer fields alongside raw output.
- Response action and Meeting Assistant ergonomics has completed a first implementation slice: `Regenerate`, `Speakable`, `Bilingual`, and `Focus` actions are available on the current suggestion; `Shorter` was removed after quick testing showed low differentiation from `Speakable`; coding response actions now preserve implementation sections when source answers include code; response length/language preferences and Meeting Assistant-specific audio settings are grouped under a collapsible `Configurations` panel; `Clear task` remains in the bottom workflow controls; main UI auto-scroll response behavior is removed; headphone/system-audio help no longer carries generic screenshot or shortcut documentation.

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
- [x] Define and implement `activeScreenTask` lifecycle:
  - starts on explicit screen capture.
  - stores visible question, task classification, relevant screenshot metadata, and recent audio context.
  - receives later transcript turns as clarification or follow-up.
  - ends on new meaningful capture, cleared non-question capture, manual clear, stop, or inactivity expiry.
  - inactivity timeout is configurable from the Meeting Assistant panel.
  - default timeout is 30 minutes of inactivity so a long discussion does not drop context too aggressively.
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
- [x] Define cursor/focus behavior:
  - record mouse position at capture time when the platform can provide it.
  - pass target-relative cursor metadata to the screen-task prompt as a focus hint.
  - send a cursor-centered horizontal focus band as the first screen-task image, followed by the full active-window image as context, when the cursor is inside the captured target.
  - prioritize text or question near cursor when multiple questions or distractors are visible.
  - use the focus band as the primary visual anchor for cursor-adjacent questions, language selectors, or UI options, so visible non-Python language selections can override the Python default.
  - show cursor focus metadata and focus band preview in Debug Mode Last capture.
- [x] Decide how Screenshot Auto prompt should interact with meeting mode:
  - recommended: treat it as user preference/instruction, not as the primary system contract.
  - it must not override technical-question output requirements.
- [x] Redesign Meeting Assistant output sections for screen tasks:
  - `Answer` is rendered first as the highest-priority meeting-ready content.
  - `Answer` must directly answer the selected visible question, not narrate which question was detected.
  - `Question`.
  - `Approach`.
  - `Code`.
  - `Complexity`.
  - `Clarifying question`.
- [x] Define how quick clarifying controls apply to active screen tasks.
- [x] Update task priority after user review.
- [~] Validate quality in mock meetings with both field-knowledge and coding questions.
  - Initial user feedback on the new implementation is positive.
  - Broader scenario coverage is still needed before calling this complete.
- [x] Add manual clear/dismiss for the active screen task.
- [x] Add configurable active screen task inactivity timeout.
- [x] Prioritize `Answer` in the screen-task prompt and UI without shortening the accepted answer/approach length.
- [x] Tighten screen-task output contract so `Answer` is direct, `Approach` stays explanation-only, and code blocks belong in `Code`.
- [x] Parse `Code (Language):` and `Implementation:` section labels as `Code` so language-qualified code blocks do not stay under `Approach`.
- [x] Render all Meeting Assistant model-output text blocks with markdown support and normalize common math delimiters (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`) for readable complexity output.
- [x] Strip outer code fences from parsed `Code` sections before displaying them in the dedicated code panel.
- [x] Validate focus-band-first screen targeting with noisy multi-question pages and non-Python language selectors.
- [x] Move screen-task answer parsing into reusable meeting-domain code.
- [x] Add optional structured screen-answer state to completed screen-task suggestions.
- [x] Parse streaming partial screen-task output on demand so partial answer rendering continues to work.
- [x] Extract accidental code fences from `Approach` into `Code` when the model drifts.
- [x] Show parsed screen-answer sections in Debug Mode.
- [ ] Continue validating screen-task section parsing for less structured model drift.

Exit criteria:

- Explicit capture returns a structured technical answer anchored to the active window.
- Later audio can update the same answer as clarification/follow-up context.
- Meeting UI supports screen-task sections and quick clarifying controls.
- Remaining focus/lifecycle hardening tasks are tracked separately.

## Milestone 5B: Interview Task Fusion First Slice

Goal: make Jarvis handle one-on-one interview-like task blocks where tasks can be screen-seeded, voice-seeded, or mixed.

- [x] Keep STT literal and non-answering; task reasoning stays in the Meeting Assistant advisor/context layer.
- [x] Update advisor prompts with interview task-block assumptions.
- [x] Treat later speech on an active screen task as constraint, follow-up, correction, strong task switch, or low-value speech.
- [x] Keep `ActiveScreenTask` as the current code type and defer `ActiveMeetingTask` migration.
- [x] Support clear voice-only technical questions without requiring a screenshot.
- [x] Ask for confirmation on explicit task-switch phrases instead of silently clearing or reusing stale context.
- [x] Add `New task`, `Same task`, `Not sure`, and `Dismiss` style quick actions for task-switch confirmations.
- [x] Filter common low-value filler before appending transcript turns or calling the advisor.
- [x] Trace ignored low-signal transcript turns as `Transcript ignored`.
- [x] Avoid refreshing active task content or expiry from empty output, `-`, or task-switch clarifying questions.
- [x] Make speech event listener registration stable so stale handlers do not create duplicate STT traces.
- [x] Mark aborted advisor requests as `cancelled` instead of successful empty outputs.
- [x] Escape provider prompt template replacements safely for markdown/math-heavy prompts.
- [x] Keep persisted metrics sanitized while increasing local history to 500 records.
- [~] Continue mock-meeting and real-use validation for low-signal false positives, stale-task incidents, and voice-only multi-turn behavior.

Exit criteria:

- Screen-seeded tasks handle spoken constraints and follow-ups directly.
- Voice-only technical questions produce useful task-like help.
- Explicit task-switch language asks for confirmation.
- Low-value utterances do not repeatedly re-solve the active task.
- No classifier model call or `ActiveMeetingTask` data migration is introduced in this slice.

## Milestone 5C: Meeting Assistant Ergonomics First Slice

Goal: make Meeting Assistant easier to tune and act on during a live meeting without opening unrelated panels or typing follow-up prompts.

- [x] Write a dedicated assignment brief for response actions and Meeting Assistant ergonomics.
- [x] Add typed response action modes: `speakable`, `bilingual`, and `focus`.
- [x] Add Meeting Assistant response configuration for answer length and natural language preference.
- [x] Add Meeting Assistant-specific audio configuration with profile, speech sensitivity, silence duration, noise gate, and max segment duration.
- [x] Persist Meeting Assistant response/audio settings inside `meeting_assistant_settings` instead of reusing headphone/system-audio `vad_config`.
- [x] Pass Meeting Assistant audio config into `start_meeting_audio_session`.
- [x] Pass response configuration into advisor prompts and screen-task prompts.
- [x] Add `Speakable`, `Bilingual`, and `Focus` buttons on the current suggestion.
- [x] Move `Regenerate` into the Response actions row.
- [x] Remove `Shorter` after quick testing showed it overlapped with `Speakable`.
- [x] Preserve coding-task `Code` sections when response action regeneration omits implementation.
- [x] Add a collapsible `Configurations` panel.
- [x] Move privacy, task memory, response, audio, and Debug Mode into `Configurations`.
- [x] Keep `Clear task` in the bottom workflow controls.
- [x] Define `Auto` language as natural-language answer selection from screen/transcript context, without overriding visible programming-language choice.
- [x] Keep Meeting Assistant response config independent from main UI response config.
- [x] Disable shared main UI `RESPONSE_SETTINGS` prompt injection for Meeting Assistant advisor and screen-analysis model calls.
- [x] Remove main UI response auto-scroll behavior and config.
- [x] Replace the `Configurations` header value summary with a short independence note.
- [x] Remove general keyboard shortcut and screenshot help from the headphone/system-audio help panel.
- [~] Validate response action quality in real Meeting Assistant usage.
- [~] Validate whether Meeting Assistant audio tuning should update an already-running audio session or only apply on restart/resume.

Exit criteria:

- The user can adjust response length and natural language preference from Meeting Assistant.
- The user can tune Meeting Assistant audio sensitivity from Meeting Assistant.
- One-click response actions transform the current answer without clearing active task context.
- Main UI response settings cannot overwrite Meeting Assistant response settings, including through the shared model-call layer.
- Normal meeting mode remains compact because settings are behind `Configurations`.
- Headphone/system-audio panel stays focused on speech capture behavior.

## Milestone 5D: Debug Trace Export

Goal: make high-value debug traces available after fast-refreshing meeting moments without requiring manual copy/paste from terminal logs.

- [x] Define Debug Mode trace export behavior in the optimization roadmap.
- [x] Add local trace export command writing JSON to app data `meeting-trace-exports`.
- [x] Export completed error traces automatically while Debug Mode is enabled.
- [x] Export completed slow traces automatically while Debug Mode is enabled, using current metrics-derived thresholds: screen >= 15s and voice >= 20s.
- [x] Add manual `Export` action for the currently visible Debug Mode trace.
- [x] Keep default exports text/metadata-only: prompts, outputs, timing, provider metadata, capture metadata, status, and errors.
- [x] Exclude raw screenshots, screenshot base64, raw audio, and audio base64 from default exports.
- [x] Validate exported JSON from a manual screen trace: parseable file, complete timing/input/output metadata, and no raw screenshot/audio payload.
- [x] Keep slow-threshold configurability as a later cleanup item rather than blocking this slice.

Exit criteria:

- Error traces are preserved even when voice traces refresh quickly.
- Unusually slow traces are exported without manual timing.
- Manual export remains available for the latest visible trace.
- Exported JSON is readable enough for prompt, latency, and provider debugging.
- Production-readiness review can later disable or narrow auto export by default.

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
- [x] Add reliable emergency hide behavior on the existing hide/show shortcut.
  - Collapse the Meeting Assistant panel.
  - Shrink the overlay back to compact size.
  - Clear native cursor override.
  - Keep meeting audio capture running.
  - Do not clear transcript by default.
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
- [ ] Evaluate OpenAI Realtime transcription as a possible future provider path.
- [ ] Define a literal, non-answering transcript cleanup prompt contract for promptable STT providers.
- [ ] Preserve original language, code-mixing, technical terms, product names, and code tokens in transcript cleanup.
- [ ] Add sentinel/marker stripping if streaming transcript output includes prompt scaffolding.
- [ ] Add provider-specific endpointing support where available.
- [ ] Add speech-end-to-final-transcript and first-partial-transcript metrics if streaming STT is implemented.
- [ ] Keep raw audio replay/storage opt-in only for explicit debug sessions.
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

## Milestone 11: Observability and Metrics

Goal: make the critical meeting workflows debuggable and measurable before prompt and UX tuning.

- [x] Create in-memory trace storage for meeting workflows.
- [x] Trace screen workflow from trigger/capture through model response and Meeting Assistant state update.
- [x] Trace voice workflow from speech detection through STT, transcript append, advisor request, and suggestion output.
- [x] Show latest trace timings in the Meeting Assistant panel.
- [x] Show raw text model/STT input and output in a local debug view.
- [x] Avoid storing raw audio bytes and screenshots in traces by default.
- [x] Gate trace detail and last capture diagnostics behind Debug Mode.
- [x] Emit timestamped terminal logs for trace lifecycle and step timing while Debug Mode is enabled.
- [x] Debounce duplicate custom shortcut events and make screen capture single-flight.
- [x] Mark aborted screen model steps as cancelled instead of successful empty outputs.
- [x] Downscale and JPEG-encode meeting screen-context images before model submission to reduce payload size.
- [x] Stream partial screen-task answers into the Meeting Assistant panel while the model is still generating.
- [x] Add native capture sub-step timings to debug metadata.
- [x] Optimize native screen-context image processing, payload size, and dev-profile image crate compilation after traces showed local image processing and oversized payloads dominated latency.
- [x] Add aggregated p50/p90 latency summaries for recent screen and voice traces in Debug Mode.
- [x] Persist sanitized trace metrics locally across app restarts.
- [ ] Add trace export if repeated testing needs offline comparison.

Exit criteria:

- A slow or incorrect critical moment can be inspected from Debug Mode without opening browser developer tools.
- Screen and voice workflows expose step-level latency and raw text I/O.
- Trace behavior remains local and privacy-conscious by default.

## Risk Register

| Risk | Impact | Mitigation | Status |
|---|---|---|---|
| Overlay appears during some screen sharing modes | High | Avoid absolute invisibility claims, add hide shortcut, recommend window sharing/second display | Open |
| System audio capture fails on some macOS/device combinations | High | Keep fallback path, improve permission and device handling | Open |
| STT latency too high | High | Add streaming STT provider interface | Open |
| STT rewrites or translates technical speech | High | Keep transcript cleanup literal, language-preserving, and non-answering; preserve jargon/code tokens | Open |
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
| 2026-05-19 | Add active screen task lifecycle controls | Screen tasks can be cleared manually, clear on stop, and expire after a configurable task memory window that defaults to 30 minutes |
| 2026-05-19 | Harden emergency hide | Existing hide/show shortcut collapses Meeting Assistant UI and keeps meeting audio capture running |
| 2026-05-19 | Enter tuning phase | Active task lifecycle and emergency hide passed user validation; next work should focus on performance and meeting UX refinements |
| 2026-05-20 | Prioritize capture latency and payload size | Debug traces showed screen resize, image encoding, and oversized image payloads could dominate end-to-end latency, so meeting screen-context captures now use 2048px downscale, JPEG encoding, media-type-aware provider requests, and optimized dev builds for image-related crates |
| 2026-05-20 | Render screen-task Answer first | Current answer and approach length is acceptable; the next UX improvement is display priority, so screen-task prompts and UI put `Answer` before supporting sections |
| 2026-05-20 | Complete first focus-aware screen targeting pass | Cursor metadata alone and rectangular crops were insufficient; the accepted path sends a horizontal focus band as Image 1 and the full active-window screenshot as Image 2, with a direct-answer/language-selection contract and markdown/math renderer hardening |
| 2026-05-20 | Persist sanitized trace metrics | Debug metrics are useful across restarts, but raw meeting content should stay out of disk history; persist timing/status/payload metadata only and keep revisiting metric quality during later tuning tasks |
| 2026-05-20 | Reframe screen/voice fusion as interview task fusion | Target scenario is one-on-one and task-block oriented; a task can be screen-seeded, voice-seeded, or mixed, so the first pass should preserve task continuity instead of building a broad meeting-topic classifier |
| 2026-05-20 | Use Brainwave as voice-pipeline reference | Borrow literal transcript cleanup, language/jargon preservation, realtime partial/final transcript ideas, and marker stripping; do not borrow default raw audio replay or move task reasoning into STT |
| 2026-05-21 | Complete prompt-level interview task fusion first slice | Keep `ActiveScreenTask`, add prompt-level screen/voice fusion, local low-signal filtering, explicit task-switch confirmation, stable speech listener registration, cancelled advisor traces, safe provider prompt replacement, and 500-record sanitized trace history |
| 2026-05-21 | Prioritize structured screen answer state before realtime STT | Current voice tests are acceptable; moving screen-task parsing into meeting-domain code improves UI stability and prepares response actions/replay without changing provider behavior |
| 2026-05-21 | Refine Meeting Assistant ergonomics scope | Remove redundant Screen toggle and duplicate config-level Clear task; group `Regenerate`/`Shorter` with response actions; keep Meeting Assistant response config independent from main UI response config; define `Auto` as natural-language auto selection |
| 2026-05-21 | Remove main UI response auto-scroll setting | Auto-scroll did not support the desired answer/code review flow; Response Settings now focuses on length and language |
| 2026-05-21 | Separate model-call response config domains | Direct Jarvis conversations keep main UI `RESPONSE_SETTINGS`; Meeting Assistant advisor/screen calls bypass that global prompt injection and use Meeting Assistant settings only |
| 2026-05-21 | Refine response actions after quick testing | Remove `Shorter`; rename `Chinese` action to `Bilingual`; keep `Speakable` and `Focus` separate because one optimizes sayable wording and the other re-centers technical content; preserve coding `Code` sections during action regeneration |
| 2026-05-21 | Add Debug Mode auto trace export | Personal-use tuning benefits from preserving fast-refreshing error and slow traces; current persisted metrics support screen >= 15s and voice >= 20s as auto-export thresholds, while keeping raw screenshots/audio out of default exports |

## Validation Snapshot

Last validated: 2026-05-21.

- `npm run build` passes.
- `cargo check` passes after selecting full Xcode as the active developer directory.
- `git diff --check` passes before commits in the current phase.
- Manual screen-context test passes well enough for the next live-meeting smoke test.
- Manual Meeting Assistant layout and cursor tests passed after expanding the panel and overriding custom cursor behavior.
- `npm run build`, `cargo check`, and `git diff --check` pass after active task lifecycle and emergency hide changes.
- User verified active task lifecycle and emergency hide behavior are usable.
- Observability trace validation confirms the duplicate hotkey/cancelled empty-output issue is resolved.
- Screen-context capture optimization reduced a reproduced slow capture from about 39.7s end-to-end to about 7.5s end-to-end in user testing.
- Latest validated screen-context trace: `image/jpeg`, about 558K base64 chars, capture about 2.0s, first token about 4.5s after trigger, full answer about 7.5s after trigger.
- User validation confirms the first cursor/focus-aware targeting pass now chooses the intended question and visible language in normal cases, even when the cursor is only near the relevant area.
- Known boundary: if the cursor is deliberately placed on a clear distractor such as another question's horizontal row, answering that distractor is expected.
- User validation confirms markdown emphasis and common complexity math now render readably in Meeting Assistant sections.
- First lightweight baseline implementation adds Debug Mode p50/p90 summaries for recent screen and voice traces.
- Baseline metrics now persist sanitized local history across app restarts without saving raw prompts, raw model outputs, screenshots, or audio.
- User validation confirms persisted metrics reload correctly after restarting Jarvis and can be read back for per-run debugging.
- Dummy meeting validation for interview task fusion is broadly positive: screen task plus constraint, screen task plus follow-up, voice-only technical question, voice-only algorithm question, and code-mixed speech all work in current testing.
- Task switch behavior is partially validated: Jarvis avoids redundant stale answers, and explicit local switch phrases now produce a confirmation workflow.
- Low-value speech behavior is improved with local filtering; continue watching false negatives and false positives during real use.
- `npm run build` and `git diff --check` pass for the interview task fusion first slice.
- Structured screen answer parser builds successfully and keeps raw output as fallback; `npm run build` and `git diff --check` pass after the first implementation slice.
- Response action and Meeting Assistant ergonomics implementation builds successfully; `npm run build` and `git diff --check` pass after response config domain separation, main UI auto-scroll removal, and the English assignment brief update.
- Quick response-action feedback is incorporated in docs and implementation: `Shorter` removed, `Chinese` action renamed to `Bilingual`, and coding action outputs guarded against losing `Code`.
- `npm run build` and `git diff --check` pass after the `Bilingual`/code-preservation response action refinement.
- Debug trace export is implemented for manual export plus Debug Mode automatic export of error/slow traces; a manual exported screen trace was inspected and confirmed parseable, complete enough for debugging, and free of raw screenshot/audio payloads.

## Immediate Next Tasks

1. P1: Manually validate Meeting Assistant `Configurations`, including response length/language persistence, independence from main UI response settings, and audio profile changes after restart/resume.
2. P1: Validate `Regenerate`, `Speakable`, `Bilingual`, and `Focus` on screen-task and voice-only suggestions, especially coding-task code preservation.
3. P1: Validate Structured Screen Answer State with fresh screen-task outputs across Python, TypeScript, JavaScript, Go, Java, and field-knowledge questions.
4. P0: Continue mock-meeting and real-use validation with screen-seeded, voice-seeded, and mixed task blocks.
5. P0: Watch low-signal filtering quality, especially whether useful short constraints are accidentally ignored or filler still triggers advisor calls.
6. P0: Watch task-switch confirmation usefulness and whether explicit `New task` / `Same task` actions feel fast enough during live use.
7. P1: Use persisted metrics during future tuning and revisit whether 500 retained sanitized records plus latest-20 baselines are enough.
8. P1: Start realtime STT or transcript cleanup work only if transcript latency, transcript cleanup, or technical-term accuracy becomes the dominant failure.
9. P1: Consider `ActiveMeetingTask` only if voice-seeded tasks need durable multi-turn state beyond transcript context.
