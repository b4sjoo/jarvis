# Jarvis Optimization Roadmap

## Purpose

This document expands the post-MVP tuning directions for Jarvis. It is meant to support step-by-step review before implementation, not to commit every item to immediate scope.

The north star remains critical moment success: Jarvis should help the user understand and answer a technical meeting moment before they need to speak.

## Current Baseline

As of 2026-05-20:

- The core Meeting Assistant flow is usable in self-testing and informal meetings.
- Active-window screen capture produces screen-anchored technical answers.
- Audio transcript can supplement an active screen task as clarification or follow-up.
- Debug Mode exposes screen and voice traces, raw text model/STT I/O, and timestamped terminal logs.
- Screen-context image payloads were optimized from multi-megabyte PNG payloads to 2048px JPEG payloads.
- Latest measured screen trace: about 558K base64 chars, about 2.0s capture, about 4.5s to first token, and about 7.5s full answer after trigger.
- Screen-task UI now renders `Answer` first while keeping `Question`, `Approach`, `Code`, `Complexity`, and `Clarifying question` available as supporting sections.
- The first cursor/focus-aware capture pass is implemented and validated for the current model setup: Jarvis sends a cursor-centered horizontal focus band first, then the full active-window screenshot as context.
- Meeting Assistant model output now has parser and renderer hardening for language-qualified `Code` sections, markdown emphasis, and common math notation in complexity text.

## Priority Model

Use this priority model for review:

- P0: likely to improve live-meeting usefulness or reduce major failure modes.
- P1: likely to improve ergonomics, debuggability, or consistency after P0 is stable.
- P2: valuable, but should wait until the core critical path is more stable.

## P0: Cursor And Focus-Aware Screen Capture

Status: implemented and validated for the first tuning pass.

### Problem

The current active-window capture is much more reliable than full-screen capture, but when a browser, editor, or shared document contains multiple questions or distracting text, the model can still choose the wrong focal point.

The user already has a natural behavior for this: keep the mouse cursor near the question that matters. Jarvis should use that signal.

### Proposed Direction

Capture and pass focus hints with each screen observation:

- Record mouse position at capture time.
- Convert global cursor position into active-window-relative coordinates when possible.
- Include cursor coordinates in capture metadata and prompt context.
- Optionally create a focused crop around the cursor while still sending the full active-window image.

Initial implementation can be conservative:

- First pass: metadata and prompt-only cursor hint.
- Second pass: full image plus cursor-centered focus image. Initial rectangular crop improved language-selector detection, but still included too many adjacent questions on dense question pages. The current implementation uses a horizontal focus band instead.

Current behavior:

- Native capture records cursor position when the platform can provide it.
- Capture metadata includes global coordinates, target-relative coordinates, normalized target position, whether the cursor was inside the captured target, and the cursor source.
- If the cursor is inside the captured target, native capture also creates a cursor-centered horizontal focus band.
- Screen-task requests send Image 1 as the focus band and Image 2 as the full active-window context.
- Screen-task prompts include `<focus_hint>` and `<image_order>` blocks. The focus band is treated as the primary visual anchor for active question, active code region, language selector, or UI option, while the full image is used only after that target is selected.
- Debug Mode shows cursor focus metadata and the focus band preview in Last capture.

Implementation notes:

- Prompt-only cursor metadata was not enough. In noisy multi-question pages the model still preferred the topmost question, and in LeetCode-like pages the default Python instruction could override a visible non-Python language selection near the cursor.
- Rectangular focus crop helped for distant UI selections such as non-Python language selectors, but could still fail on tightly stacked question lists because adjacent questions entered the crop.
- The horizontal focus band is intended to preserve left/right text context while reducing vertical ambiguity.
- User testing showed that a correct focus band was still not enough when it was sent after the full screenshot; the model could still answer from the global image. The current input order sends the focus band first to make the visual priority structural, not only prompt-based.
- Follow-up testing exposed an output-quality issue where `Answer` could describe which question was identified instead of directly answering it. The current prompt contract now requires direct answers and forbids putting selection narration in `Answer`.
- Language selection is a high-value edge case, so selected focus-band language is treated as a hard requirement. TypeScript is called out as distinct from JavaScript, and the parser checks language labels before falling back to Python.
- Rendering issues discovered during this work are now part of the optimization result: `Code (Language):` and `Implementation:` are parsed as code, dedicated code panels strip outer fences, and Meeting Assistant text sections normalize markdown and common math delimiters before rendering.

Validation result:

- User testing with a stronger model now shows stable question and language recognition even when the cursor is not exactly on the target, as long as the cursor is not placed on a clear distractor such as another question's horizontal row.
- Multi-question pages work reliably in the common case where the cursor's horizontal focus band isolates the intended row.
- Visible non-Python language choices now override the Python default in normal testing.
- Markdown emphasis and complexity math such as `O(m x n)` now render readably in `Approach` and `Complexity`.

### Expected Impact

- Higher correct-question detection rate on noisy screens.
- Fewer hallucinated or generic answers when multiple visible questions exist.
- Less need for repeated captures.

### Risks

- Cursor position may be unavailable or misleading if the cursor is parked away from the question.
- Sending both full image and crop increases payload and model cost.
- Crop-only answers may miss global context.

### Validation

Use repeated scenarios:

- Two visible technical questions, cursor near target question.
- Code editor with problem statement and unrelated comments.
- Browser page with sidebars and multiple headings.
- Cursor away from target question as a negative test.

Metrics:

- Correct question detection rate.
- Need-to-regenerate rate.
- Screen capture to first token latency after adding the crop.
- Focus band payload size and whether it materially changes end-to-end latency.

### Open Questions

- Is the current always-on focus band acceptable for latency and cost after more aggregate traces?
- Should focus band height become configurable only if repeated failures show different pages need different vertical ranges?
- If explicit distractor-row cases become important, should the next step be local OCR plus cursor-nearest text-block extraction rather than more prompt wording?

## P0: Lightweight Latency And Quality Baseline

Status: implemented for the first tuning pass. Debug Mode shows recent p50/p90 metrics, and sanitized metrics persist across app restarts for later local debugging.

### Problem

Debug traces are useful per incident, but manual trace reading does not scale. We need a small aggregate view to understand whether tuning improves real usage.

### Proposed Direction

Add an in-memory metrics summary over recent traces:

- Recent N screen traces and voice traces.
- p50/p90 for capture duration, first-token latency, model duration, and end-to-end duration.
- Image payload size and output length summaries.
- Error/cancelled/success counts.

Keep this local and debug-only at first. Persist only sanitized metric records to disk so future debugging can compare app sessions without saving raw prompts, raw model outputs, screenshots, or audio.

### Expected Impact

- Easier to compare before/after changes.
- Faster diagnosis when the app feels slow.
- Better prioritization between capture, provider, prompt, and UI work.

### Risks

- Metrics UI can clutter the Meeting Assistant if exposed too aggressively.
- Aggregates can hide scenario-specific failures.
- Raw trace data should remain in memory unless export is explicitly requested later; persisted history must stay sanitized.

### Validation

Metrics should answer:

- Is the latest change faster than the previous baseline?
- Is the bottleneck capture, model first token, full generation, or UI update?
- Do long answers correlate with slower model completion?

Candidate acceptance:

- Debug Mode shows a compact `Recent latency` section.
- Jarvis writes a local `meeting-trace-metrics.json` history and loads it on startup.
- Persisted history includes timing, status, payload sizes, provider IDs, and sanitized capture metadata only.
- No raw screenshots or audio are persisted.
- No raw model/STT prompts or outputs are persisted in the metrics history.
- Existing trace details remain available for deep debugging.

### Open Questions

- Should the summary live inside Meeting Assistant Debug Mode or a separate dev/debug panel?
- Should p50/p90 be calculated over the latest 10, 20, or configurable number of traces?
- Do we need manual scenario labels before aggregation becomes useful?
- Should persisted metrics keep only the latest 20 records, or should we eventually retain a longer rolling history for multi-day tuning? Decide after using the current metrics during future optimization tasks.

## P0/P1: Screen And Voice Fusion Hardening

### Problem

The current design treats screen as the primary task and voice as supplemental clarification. That is the right product direction, but the semantics of speech are still coarse.

In a real meeting, speech after a screenshot can mean:

- Add a constraint.
- Ask a follow-up.
- Change the target question.
- Disagree with or correct the previous answer.
- Be unrelated meeting chatter.

Jarvis should distinguish these cases better.

### Proposed Direction

Introduce a lightweight turn classifier before updating an active screen task:

- `clarification`: modifies the active task constraints.
- `follow-up`: asks a new question about the same task.
- `new-topic`: likely requires a new capture or clears active task influence.
- `ambient`: should not change the active screen task.

Start as prompt-only logic inside the advisor request. Move to a separate classifier only if traces show repeated mistakes.

### Expected Impact

- Fewer stale-context answers.
- Better follow-up handling.
- Less overreaction to unrelated speech.

### Risks

- Extra classification can add latency if implemented as a separate model call.
- Prompt-only classification may be inconsistent.
- Misclassification could suppress useful follow-up context.

### Validation

Scenario set:

- Screen question plus spoken constraint.
- Screen question plus spoken follow-up.
- Screen question followed by unrelated meeting chat.
- New question verbally introduced without a new screenshot.

Metrics:

- Correct follow-up binding rate.
- Stale active task incidents.
- User-initiated clear task frequency.

### Open Questions

- Should speech ever automatically clear an active screen task?
- Should Jarvis ask a click-answerable clarification when it suspects topic switch?
- Should transcript turns show whether they were bound to the active screen task?

## P1: Structured Screen Answer State

### Problem

The UI currently parses raw model output into sections. This works, but it is still a text parser over a streaming response. More structure would make rendering, quick actions, and future replay more reliable.

User testing also found a concrete failure mode: a code block can appear under `Approach` instead of rendering in the `Code` section when the model drifts from the expected labels. The immediate prompt-level mitigation is to forbid code blocks in `Approach`, but the durable fix belongs in this structured-answer workstream.

Current parser hardening handles `Code (Language):` and `Implementation:` as code labels, which fixes the observed `Code (Rust):` output shape. The Meeting Assistant now renders all model-output text blocks through the same markdown/math normalization path, normalizes common math delimiters such as `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`, and strips outer code fences in the dedicated code panel. Broader malformed-output recovery still belongs here.

### Proposed Direction

Create a structured screen answer representation:

```ts
interface ScreenTaskAnswer {
  question?: string;
  answer?: string;
  approach?: string;
  code?: string;
  complexity?: string;
  clarifyingQuestion?: string;
  rawContent: string;
  parsedAt: number;
}
```

Keep raw content for fallback and Debug Mode. The parser can remain local at first; no need to force JSON model output yet.

### Expected Impact

- Cleaner Answer-first UI.
- Easier future actions such as `copy code`, `show answer only`, or `explain approach in Chinese`.
- More reliable trace/replay comparisons.

### Risks

- Parsing may still fail if model labels drift.
- Strict JSON output may reduce natural answer quality if adopted too early.
- Adds state complexity without immediate quality improvement unless paired with UI actions.

### Validation

- Existing raw-text outputs still render.
- Screen-task sections render correctly during partial streaming and after completion.
- Debug Mode can show both parsed sections and raw output.
- Code blocks generated by the model render under `Code`, not `Approach`, across Python, TypeScript, JavaScript, Go, and Java examples.
- Complexity math displays as readable text or rendered markdown instead of exposing raw `$$...$$` delimiters.

### Open Questions

- Should structured state live inside `AdvisorSuggestion`, `ActiveScreenTask`, or a new screen-task answer field?
- Should we parse incrementally during streaming or only after full response?
- Is JSON mode worth using later for providers that support it?

## P1: Response Action Ergonomics

### Problem

Meeting moments often need a different response style than the first generated answer. The current `Regenerate` and `Shorter` actions help, but they are broad.

### Proposed Direction

Add small, click-based actions that map to common meeting needs:

- `Say it more naturally`
- `Short speaking answer`
- `Explain in Chinese`
- `Focus on code`
- `Focus on tradeoffs`
- `Ask a clarifying question`

These should be actions on the current active screen task or latest suggestion, not global prompt settings.

### Expected Impact

- Less typing during meetings.
- Faster conversion from technical answer to speakable response.
- Better support for non-native English pressure moments.

### Risks

- Too many buttons can clutter the panel.
- Extra model calls add latency and cost.
- Some actions overlap with existing `Shorter`.

### Validation

- User can perform common refinement with one click.
- Result appears without losing the active task context.
- UI remains calm and compact.

### Open Questions

- Which two or three actions should ship first?
- Should actions be always visible or hidden behind a compact menu?
- Should actions modify the existing answer or create a new suggestion entry?

## P1: Trace Export And Replay

### Problem

When answer quality issues are subtle, screenshots and prompts need to be inspected outside the live meeting moment. Current traces are in-memory and local, which is good for privacy but limited for deeper debugging.

### Proposed Direction

Add explicit opt-in trace export:

- Export selected trace as JSON.
- Include prompt text, model output, timing, provider metadata, capture metadata.
- Do not include raw screenshot or audio by default.
- Optionally include image only if the user explicitly chooses a debug export with media.

Replay can come later:

- Re-run the same prompt and image against a provider.
- Compare output across prompt versions or models.

### Expected Impact

- Easier prompt iteration.
- Better bug reports for ourselves.
- Safer debugging because export is explicit.

### Risks

- Export files can contain sensitive prompt, transcript, or screen metadata.
- Replay can become a large feature if overbuilt.
- Including images requires careful consent and labeling.

### Validation

- Exported JSON is readable and complete enough for diagnosis.
- Default export excludes raw screenshots and audio.
- UI makes sensitivity clear.

### Open Questions

- Where should exports be saved?
- Should export be a Debug Mode-only feature?
- Should image inclusion be a separate one-time checkbox?

## P2: Automatic Screen Observation

### Problem

Manual hotkey capture works and keeps cost/privacy under control. Automatic observation could reduce friction, but it can also create noise, cost, and privacy risk.

### Proposed Direction

Delay full automatic observation until focus selection and trace baselines are stable.

When revisited:

- Use conservative interval.
- Skip unchanged screen hashes.
- Rate-limit vision calls.
- Show clear indicator when auto observation is active.
- Keep manual capture as the primary reliable action.

### Expected Impact

- Lower friction when the user forgets to capture.
- Better context for rapid screen changes.

### Risks

- Accidental sensitive screenshots to cloud.
- More provider cost.
- More stale or noisy context.

### Validation

- Auto mode does not flood model calls.
- User can always tell when it is active.
- Manual capture remains more precise than automatic context.

### Open Questions

- What is the minimum safe default interval?
- Should automatic mode be local-only until explicit cloud consent?
- Should auto observation use OCR/local heuristics before model calls?

## P2: Knowledge And Memory Base

### Problem

Jarvis could answer better with field knowledge, personal work summaries, project glossary, and recurring context. But if current failures are caused by focus selection or stale task handling, memory will not fix them.

### Proposed Direction

Keep deferred until P0 instrumentation and focus work produce more evidence.

First version should be simple:

- User profile memory.
- Work summary memory.
- Field glossary.
- Project notes.
- Prompt-time injection.

Avoid embeddings, semantic cache, and complex retrieval until there is a clear need.

### Expected Impact

- More personalized answers.
- Better vocabulary and domain-specific suggestions.
- Faster answers for repeated concepts if lightweight cache is added later.

### Risks

- Stale memory can confidently mislead.
- Sensitive company information needs careful handling.
- Retrieval can add complexity and latency.

### Validation

- Memory improves repeated field-knowledge answers.
- User can inspect, edit, and delete memory.
- Memory is not injected when irrelevant.

### Open Questions

- Should memory be per project, global, or both?
- Should memory be local-only by default?
- What should be manually curated versus learned from meetings?

## Recommended Review Order

1. Cursor and focus-aware screen capture.
2. Lightweight latency and quality baseline.
3. Screen and voice fusion hardening.
4. Structured screen answer state.
5. Response action ergonomics.
6. Trace export and replay.
7. Automatic screen observation.
8. Knowledge and memory base.

The recommended next implementation slice is either cursor/focus-aware capture or latency baseline. Cursor/focus improves answer correctness; latency baseline improves our ability to judge every later optimization.
