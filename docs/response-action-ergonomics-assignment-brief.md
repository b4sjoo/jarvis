# Response Action And Meeting Assistant Ergonomics Assignment Brief

## Purpose

This optimization makes Meeting Assistant easier to adjust and easier to act on during real meetings.

The original task only covered one-click response actions. After review, the scope expanded into a small control-surface cleanup for Meeting Assistant:

- Add one-click actions for the current answer.
- Add a dedicated collapsible `Configurations` section inside Meeting Assistant.
- Group response, context, audio, and debug settings in that section.
- Clean up the headphone/system-audio panel so it focuses on speech capture instead of global shortcuts or screenshot help.

This work does not change Jarvis's core meeting-understanding model. It reduces operational friction: fewer scattered controls, less typing during meetings, and faster tuning of answer style and audio behavior.

## User Problem

Jarvis can now produce useful screen-anchored and voice-seeded technical answers, but several meeting-time friction points remain:

- The answer may be technically correct but not phrased as something the user can say aloud.
- The user sometimes needs a quick Chinese explanation to understand the reasoning behind the answer.
- Different meetings need different answer lengths, from one-line replies to more detailed reasoning.
- Meeting Assistant had fixed VAD settings even though the headphone panel already exposed speech sensitivity, silence duration, and noise gate controls.
- Meeting Assistant settings were scattered in the main panel instead of living in one predictable place.
- The headphone panel mixed system-audio controls with general keyboard shortcut and screenshot documentation.

These issues become larger during a live meeting. Every extra click, search, or manual prompt slows the user's ability to understand the question and formulate an answer.

## Product Goal

Create a quiet, compact, predictable Meeting Assistant control layer for two core live-meeting actions:

1. Transform or focus the current answer with one click.
2. Adjust Meeting Assistant behavior from inside the Meeting Assistant panel.

The first version should support:

- Grouping `Regenerate`, `Shorter`, and targeted response actions in one action row.
- Rewriting the current answer as something the user can say aloud in English.
- Explaining the current answer in Chinese.
- Focusing the current answer on the most useful technical point.
- Adjusting default response length and natural-language preference.
- Adjusting Meeting Assistant audio listening parameters.
- Keeping task memory, privacy/Text+Screen mode, and debug settings in one predictable place.

## Scope

### 1. Response Actions

The first version includes two kinds of actions.

Base actions:

| Action | Intent | Output Behavior |
|---|---|---|
| `Regenerate` | Regenerate the current suggestion with the current Meeting Assistant response config. | Follows current length and language settings. |
| `Shorter` | Regenerate one length level shorter without mutating saved settings. | `Detailed -> Normal`, `Normal -> Short`, `Short -> Short`. |

Rewrite actions:

| Action | Intent | Output Behavior |
|---|---|---|
| `Speakable` | Rewrite the current answer into something the user can naturally say in a meeting. | Short, direct, English; avoid code unless required. |
| `Chinese` | Explain the current answer or reasoning in Chinese. | Concise Chinese, preserving key English technical terms. |
| `Focus` | Focus the current answer on the most useful technical part. | Prefer code, tradeoffs, complexity, or key reasoning. |

Actions must preserve current active task context and only update the current suggestion presentation.

### 2. Meeting Assistant Configurations

Add a dedicated collapsible `Configurations` section inside Meeting Assistant.

Default behavior:

- Stay collapsed or visually quiet during normal meeting use.
- Remain discoverable in the Meeting Assistant panel.
- Avoid requiring the user to open the headphone/system-audio panel to tune Meeting Assistant behavior.

Configuration groups:

| Group | Controls |
|---|---|
| `Response` | Answer length and natural-language preference. |
| `Context` | Privacy mode and task memory timeout. |
| `Audio` | Audio profile, speech sensitivity, silence duration, noise gate, and max segment duration. |
| `Debug` | Debug Mode and trace detail visibility. |

First response config:

- `Response length`: `Short` / `Normal` / `Detailed`
- `Language`: `Auto` / `English` / `Chinese`
- Deferred: `Style`: `Meeting-ready` / `Technical` / `Interview`

`Auto` only controls the natural language used for the answer. It means Jarvis should choose the answer language from screen and transcript context. It does not control programming language. Code language still follows visible screen selection first, explicit screen text second, transcript clarification third, and Python as the fallback.

Meeting Assistant response length does not share storage or exact semantics with the main UI response length:

- Main UI `Short`: strict 2-4 sentence answer.
- Main UI `Medium`: balanced 1-2 paragraph answer.
- Main UI `Auto`: model chooses length based on question complexity.
- Meeting Assistant `Short`: fastest meeting-ready answer.
- Meeting Assistant `Normal`: compact default answer for live meeting use, closest in spirit to main UI `Medium`.
- Meeting Assistant `Detailed`: more reasoning, code, or tradeoffs while still respecting live-meeting usefulness.

First audio config:

- `Audio profile`: `Quiet` / `Balanced` / `Sensitive`
- `Speech sensitivity`
- `Silence duration`
- `Noise gate`
- `Max segment duration`

### 3. Headphone Panel Cleanup

The headphone/system-audio panel should focus on system audio capture and speech listening.

Remove from its `Help & Keyboard shortcuts` area:

- General shortcut documentation.
- Screenshot feature documentation.

Those topics can later move to a global help surface. For this slice, removing the redundant content is acceptable as long as core functions stay discoverable from the main UI.

## Background

This task can reuse existing Jarvis infrastructure:

- Completed screen-task suggestions can carry `screenTaskAnswer`.
- `screenTaskAnswer` already has structured fields such as `question`, `answer`, `approach`, `code`, `complexity`, and `clarifyingQuestion`.
- `activeScreenTask` preserves the current screen-seeded task context.
- Advisor requests already support `regenerate`, `shorter`, `screen-anchored`, and `clarifying-answer` modes.
- Debug traces already record model input/output and step timing.
- The native meeting audio session already accepts `vadConfig`.
- Meeting Assistant previously used fixed `DEFAULT_MEETING_AUDIO_CONFIG`; the missing pieces were UI state, persistence, and wiring.

This does not need a new subsystem. The right path is to reuse the existing provider, advisor, trace, and native audio paths.

## Non-Goals

This slice does not:

- Implement realtime STT streaming.
- Migrate `ActiveScreenTask` to `ActiveMeetingTask`.
- Build a complex action marketplace.
- Add a large number of response buttons.
- Implement action history.
- Require JSON-mode model output.
- Persist raw prompts, raw model outputs, screenshots, or audio.
- Add a shared response config layer between the main UI and Meeting Assistant.
- Keep the main UI auto-scroll response behavior or config.
- Let headphone/system-audio settings automatically overwrite Meeting Assistant settings.
- Expose full system prompt editing.

## Constraints

- The UI must remain quiet and compact.
- Meeting-time actions should be one-click whenever possible.
- Response actions must preserve active task context.
- Response actions should work best on screen-task suggestions and degrade gracefully for voice-only suggestions.
- Existing `Regenerate`, `Shorter`, pause/resume, clear task, and emergency hide workflows must keep working.
- The first version should use the currently selected AI provider and existing model request path.
- Debug traces should record action mode and response configuration.
- Meeting Assistant audio settings must be stored separately from headphone/system-audio settings.
- Meeting Assistant response settings must be stored separately from main UI response settings.
- Main UI response language or length must not overwrite Meeting Assistant response behavior.
- Meeting Assistant model calls must bypass the main UI `RESPONSE_SETTINGS` injection in the shared `fetchAIResponse` layer.
- Main UI direct Jarvis conversations keep the default `RESPONSE_SETTINGS` injection.
- Default behavior should stay close to the current version when the user has not changed settings.
- User preferences can shape expression style, but they must not weaken core Jarvis constraints such as screen-first reasoning, no invented coworkers, and no invented screen content.

## UX Direction

Recommended layout:

- Keep the main answer area as the highest-priority content.
- Add a compact response action row near the answer controls with `Regenerate`, `Shorter`, `Speakable`, `Chinese`, and `Focus`.
- Add a collapsible `Configurations` section in Meeting Assistant.
- Move privacy, task memory, and Debug Mode into `Configurations`.
- Put audio tuning inside the `Audio` group.
- Keep `Clear task` in the bottom low-frequency workflow controls, not inside `Configurations`.
- Use a short `Configurations` subtitle that states the settings are meeting-only and independent from the main UI.

Text labels are acceptable for response actions because meeting-time clarity matters more than visual minimalism:

- `Regenerate`
- `Shorter`
- `Speakable`
- `Chinese`
- `Focus`

Configuration labels should stay practical. Avoid long in-app explanations unless a setting is easy to misuse.

## Prompt Contract

Action prompts should treat the current suggestion as source material. They should not answer a separate task from scratch.

General rules:

- Preserve active task and visible question.
- Do not invent constraints or screen content.
- Avoid repeating the full original answer unless needed.
- Keep output useful during a live meeting.
- If the current suggestion is insufficient, ask a concise clarifying question instead of guessing.

`Speakable`:

- Output one to three English sentences.
- Sound natural, professional, and sayable.
- Avoid code blocks.
- Mention complexity only when it is central to the answer.

`Chinese`:

- Explain concisely in Chinese.
- Preserve key English technical terms such as `RAG`, `heap`, `rate limiter`, `TypeScript`, and `O(n)`.
- Avoid long tutorial-style explanations.

`Focus`:

- Choose the most useful focus point from the structured fields.
- If code exists, prefer implementation details, edge cases, or complexity.
- If no code exists, prefer tradeoffs, complexity, or key reasoning.
- Keep output compact.

Response configuration prompt:

- `Short` should prioritize the most sayable and actionable summary.
- `Normal` should preserve the default compact Jarvis style.
- `Detailed` can include more reasoning, code, or tradeoffs where useful.
- `Auto` language chooses natural answer language from screen and transcript context without overriding visible programming language.
- `English` prefers meeting-ready English.
- `Chinese` prefers Chinese explanation while preserving key English technical terms.

## Technical Direction

Likely code areas:

- `src/lib/meeting/types.ts`
  - Add `MeetingResponseActionMode`.
  - Add `MeetingResponseConfig`.
  - Extend `MeetingAssistantSettings`.
- `src/lib/meeting/advisor-prompt.ts`
  - Add action-specific prompt instructions.
  - Add response length and language guidance.
- `src/lib/meeting/screen-observation.service.ts`
  - Pass response config into screen-task prompt construction where needed.
  - Pass `applyResponseSettings: false` into Meeting Assistant model calls.
- `src/lib/meeting/advisor-engine.ts`
  - Reuse the existing advisor request flow.
  - Record action mode and response config in trace metadata.
  - Pass `applyResponseSettings: false` into Meeting Assistant advisor calls.
- `src/lib/functions/ai-response.function.ts`
  - Keep `applyResponseSettings` defaulting to `true` for main UI calls.
  - Allow Meeting Assistant callers to bypass main UI response settings injection.
- `src/hooks/useMeetingAssistant.ts`
  - Add `applyResponseAction(actionMode)`.
  - Persist Meeting Assistant response and audio config.
  - Pass persisted audio config to `start_meeting_audio_session`.
  - Implement `Shorter` as a temporary Meeting Assistant response length downgrade.
  - Keep Meeting Assistant audio config separate from system-audio `vad_config`.
  - Keep Meeting Assistant response config separate from main UI `RESPONSE_SETTINGS`.
- `src/pages/app/components/meeting/index.tsx`
  - Add compact response action controls.
  - Add collapsible `Configurations`.
  - Move privacy, task memory, and Debug Mode into the new section.
  - Add response and audio controls.
  - Keep `Clear task` in the bottom workflow controls.
- `src/pages/app/components/speech/Warning.tsx`
  - Remove generic shortcut and screenshot help from headphone/system-audio help.
- `src/pages/responses/*`
  - Remove main UI auto-scroll response behavior and config.

Reusable inputs:

- `latestSuggestion.content`
- `latestSuggestion.screenTaskAnswer`
- `activeScreenTask.content`
- `activeScreenTask.question`
- Latest transcript turns
- Latest screen observations

Reusable patterns:

- VAD sliders and presets from the headphone/system-audio panel.
- Current Meeting Assistant privacy, task-memory, and debug controls.
- Existing `Regenerate` and `Shorter` advisor flows.

## Persistence Direction

Meeting Assistant persists its own settings:

- `meetingAssistantSettings.response`
- `meetingAssistantSettings.audio`
- `meetingAssistantSettings.context`
- `meetingAssistantSettings.debug`

The headphone/system-audio panel keeps its own existing storage key. Meeting Assistant does not read or write that key by default.

Main UI direct Jarvis conversation settings remain in `RESPONSE_SETTINGS` and apply only to direct Jarvis model conversations through the default `fetchAIResponse` path.

## Expected Outputs

Code outputs:

- Typed action mode.
- Typed response configuration and audio configuration.
- Action-specific advisor prompt handling.
- One-click action controls in Meeting Assistant.
- `Regenerate` and `Shorter` moved into response action controls.
- `Shorter` reuses Meeting Assistant response length downgrade semantics.
- Collapsible `Configurations` section.
- Persisted Meeting Assistant audio config wired into native audio start.
- Response config wired into Meeting Assistant prompt paths.
- Meeting Assistant model calls bypass main UI response settings injection.
- Main UI auto-scroll response behavior and config removed.
- Redundant headphone/system-audio help removed.
- Debug traces record action mode and configuration metadata where appropriate.

Documentation outputs:

- Update `docs/optimization-roadmap.md`.
- Update `docs/meeting-assistant-task-tracking.md`.
- Keep this assignment brief in English for review.

Validation outputs:

- `git diff --check`
- `npm run build`
- `cargo check` only if Rust/Tauri files change.

## Acceptance Matrix

| Scenario | Expected Behavior |
|---|---|
| Screen coding task has a full answer, click `Speakable` | Returns concise, natural English wording without unnecessary code blocks. |
| Screen algorithm task, click `Chinese` | Explains the algorithm and complexity in Chinese while preserving key technical terms. |
| Screen coding task has a code section, click `Focus` | Focuses on implementation, edge cases, or complexity instead of repeating every section. |
| Field-knowledge question, click `Speakable` | Generates meeting-ready English wording. |
| Voice-only technical suggestion, click `Chinese` | Explains the current suggestion without requiring screen context. |
| No current suggestion | Action controls are disabled or hidden. |
| Active screen task exists | Actions do not clear active task; they only update suggestion content. |
| Meeting response length is `Detailed`, click `Shorter` | Regenerates with `Normal` length without mutating saved `Detailed` setting. |
| Meeting response length is `Normal`, click `Shorter` | Regenerates with `Short` length without mutating saved `Normal` setting. |
| Meeting response length is `Short` | New Meeting Assistant answers are visibly compact. |
| Meeting language is `Chinese` | New answers prefer Chinese explanation while preserving key English technical terms. |
| Meeting language is `Auto` | Natural answer language follows screen/transcript context; code language still follows visible selection or Python fallback. |
| Main UI response language changes | Meeting Assistant response language is not overwritten. |
| Main UI response length changes | Meeting Assistant response length is not overwritten. |
| Meeting Assistant model call runs | It does not receive main UI `RESPONSE_SETTINGS` prompt injection. |
| Direct Jarvis conversation runs | It still receives main UI response length and language settings. |
| Audio profile is set to `Sensitive` | Restarting Meeting Assistant audio uses the new VAD settings. |
| Debug Mode off | Last capture and trace detail stay hidden. |
| Debug Mode on | Last capture and trace detail are visible. |
| Headphone panel opens | It no longer shows generic screenshot or global shortcut help. |
| Response Settings page opens | It shows response length and language only; auto-scroll is absent. |

## Success Criteria

- The user can rewrite an answer into a sayable version with one click.
- The user can get a Chinese explanation with one click.
- The user can focus a broad answer without typing.
- The user can adjust Meeting Assistant answer length and language from Meeting Assistant.
- The user can tune Meeting Assistant audio sensitivity from Meeting Assistant.
- Privacy, task memory, audio, response, and debug controls have one unified location.
- `Clear task` remains in the bottom low-frequency workflow controls.
- Normal meeting mode stays compact.
- Screen-task rendering, clarifying-question controls, active task lifecycle, and emergency hide do not regress.
- Debug traces show which action or config path was used.
- Main UI Response Settings controls only direct Jarvis model conversation behavior.
- Meeting Assistant controls only Meeting Assistant model behavior.

## Risks

- Too many visible controls can clutter the panel.
- If prompts are not distinct enough, `Speakable`, `Chinese`, or `Focus` may behave like plain regeneration.
- Extra model calls add latency and cost.
- If action output replaces the original answer, the user may lose useful detail.
- `Focus` can feel unpredictable if rules are too broad.
- Audio tuning controls can be too low-level for quick meeting use.
- Response config priority can conflict with task-specific prompt rules if boundaries are unclear.

## Decisions

- Response action controls are directly visible.
- `Regenerate` and `Shorter` belong with response actions, not bottom workflow controls.
- `Shorter` uses a temporary Meeting Assistant response length downgrade instead of a separate prompt branch.
- Meeting Assistant response config and main UI response config are independently persisted.
- `fetchAIResponse` injects main UI response settings by default only for direct Jarvis conversation paths.
- Meeting Assistant advisor and screen calls pass `applyResponseSettings: false`.
- `Auto` language means natural-language answer auto-selection, not programming language auto-selection.
- `Clear task` stays in the bottom workflow controls.
- Privacy keeps only three modes and removes the extra Screen toggle.
- Main UI auto-scroll response behavior had low value for the desired answer/code review workflow, so the feature and config are removed.

## Open Questions

- Should action results replace the current suggestion, or should Jarvis later add an alternate-answer view?
- Should `Speakable` eventually become the default first display field?
- If `Focus` is unstable, should it split into explicit `Code`, `Tradeoffs`, and `Complexity` actions?
- Should action output preserve screen-task section format or use a compact `Meaning / Reply / Question` format?
- Should `Configurations` remember expanded/collapsed state across launches?
- Should a narrow `Personal guidance` field exist later, or should preferences stay structured only?

## Recommended First Implementation Order

1. Add collapsible `Configurations` to Meeting Assistant.
2. Move privacy, task memory, and debug controls into it.
3. Add response length and language controls and wire them into prompts.
4. Add Meeting Assistant audio presets and persist them separately from system-audio settings.
5. Add response action buttons and place `Regenerate` / `Shorter` in the same row.
6. Remove generic shortcut and screenshot help from the headphone/system-audio panel.
7. Remove main UI auto-scroll response behavior and config.
8. Add the model-call boundary that keeps main UI response settings out of Meeting Assistant calls.

This order keeps default behavior stable, gives later controls a clear home, reduces UI scatter before adding actions, and keeps Meeting Assistant settings separate from headphone/system-audio and direct Jarvis conversation settings.
