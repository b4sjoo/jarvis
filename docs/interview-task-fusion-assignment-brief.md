# Interview Task Fusion Assignment Brief

## Purpose

This brief defines the next optimization task for Jarvis: improve how voice and screen context combine during interview-like software engineering conversations.

This work should be reviewed before implementation because the problem boundary is fuzzy and the real-world edge cases are numerous.

## Product Assumptions

The target scenario for this phase is closer to an interview or one-on-one technical evaluation than a broad multi-person meeting.

- The meeting is usually one-on-one.
- The other speaker is usually the interviewer, requester, or question owner.
- The user is usually the solver or respondent.
- Discussion is organized into task blocks lasting roughly 15-30 minutes.
- Within a task block, most new speech is useful context, not unrelated chatter.
- The screen may or may not be continuously useful.
- Some task blocks may be pure voice with no visible question.
- System audio can be treated as `them` for now; speaker diarization is not required in this phase.

## Core Model

A task block may be:

- `screen-seeded`: an explicit screen capture provides the initial problem or code context.
- `voice-seeded`: a clear spoken technical question starts the task without a screen.
- `mixed`: voice and screen both contribute important context over time.

Guiding rule:

First strong task signal creates the task; later signals steer it.

Strong task signals include:

- Explicit screen capture with a meaningful technical question, code, diagram, or requirement.
- Clear voice-only technical question.
- User action such as manual clear, regenerate, or a clarifying answer.
- Strong spoken task switch phrase such as "next question", "let's move on", or an obviously new problem.

Weak signals should not automatically clear or replace the task.

## Design Direction

The first implementation should avoid a separate classifier model call. Extra classification adds latency and may not be necessary for the current interview-like scope.

Start with prompt-level task fusion:

- If an active screen task exists, assume later speech is relevant unless there is a strong switch signal.
- If speech adds constraints, revise the answer or approach against the current task.
- If speech asks a follow-up, answer the follow-up directly while preserving the task context.
- If speech appears to introduce a new task, ask for confirmation or suggest a new capture rather than automatically clearing the current task.
- If no active screen task exists and the latest transcript is a clear technical question, handle it as a voice-seeded task-like moment.
- If speech is low-value chatter, stay quiet or give minimal context.

Screen should not always dominate. Screen is the source of truth when it provides the active problem, but voice can create a task when no screen is available and can steer the task after it exists.

## Brainwave Reference Takeaways

The local `brainwave` repo is useful as a voice-pipeline reference, not as a replacement architecture for Jarvis.

What to borrow:

- Keep transcription and advising separate. The STT/transcript layer should produce literal speech text and should never answer the question.
- Use a transcript-cleanup prompt that preserves the original language, code-mixing, technical terms, product names, and jargon.
- Remove only non-lexical filler and obvious disfluency; avoid translating or rewriting the speaker's intent.
- Consider a fixed marker/sentinel for streaming transcript output so formatting instructions can be stripped before appending transcript text.
- Consider a future realtime transcription provider with partial/final transcript events and manual/local endpointing.
- Buffer audio until the realtime provider is ready, then flush in order, so short connection delays do not drop speech.

What not to borrow by default:

- Do not store raw audio chunks for replay unless the user explicitly enables an opt-in debug session.
- Do not collapse Jarvis's task fusion into the STT layer. Transcript quality improves task fusion, but task state still belongs in the Meeting Assistant context/advisor layer.
- Do not add provider-specific realtime code before prompt-level interview task fusion proves its limits.

Priority implications:

- P0 design constraint: STT must remain literal, non-answering, and language-preserving.
- P0 current slice: implement prompt-level interview task fusion using existing transcript turns.
- P1 follow-up: add a realtime transcript quality workstream if voice-only or follow-up tests show STT latency or cleanup quality is the bottleneck.
- P2 later: add opt-in audio replay/export tooling only if debug metrics show it is needed.

## Implementation Scope

First pass:

- Update advisor prompts for interview task continuity.
- Improve `screen-anchored` behavior so voice can be treated as constraint, follow-up, correction, or strong switch signal.
- Improve transcript-only behavior so clear technical voice questions receive task-like answers rather than generic meeting advice.
- Preserve the current `ActiveScreenTask` type in code.
- Document the conceptual direction toward `ActiveMeetingTask`, but do not migrate the type system yet.
- Do not add a separate LLM classifier call.
- Do not automatically clear active tasks based only on speech.
- Keep using persisted metrics and Debug Mode traces to inspect behavior.
- Preserve the STT/advisor boundary: do not move task reasoning into transcription cleanup.
- If transcript cleanup prompt changes are needed, keep them literal and non-answering.

Potential later pass:

- Introduce `ActiveMeetingTask` with `source: "screen" | "voice" | "mixed"`.
- Store voice-seeded task state explicitly.
- Add transcript turn binding metadata.
- Add click-answerable task-switch confirmation.
- Add a separate classifier only if prompt-level behavior repeatedly fails.
- Add an optional realtime STT provider with partial/final transcript events if transcript latency becomes a top bottleneck.
- Add opt-in transcript/audio replay only as a debug tool, with raw audio disabled by default.

## Non-Goals

- Multi-speaker diarization.
- Full meeting-topic segmentation.
- Automatic task switching without user confirmation.
- Long-term memory or knowledge base integration.
- A broad classifier for all possible meeting conversation types.
- Persisting raw transcript, raw model output, audio, or screenshots in metrics history.
- Rewriting the voice stack before prompt-level task fusion is validated.
- Making STT responsible for answering, classifying, or managing task state.

## Expected User Experience

When a screen task exists:

- The user can keep discussing the same problem for 15-30 minutes.
- Spoken constraints update the answer.
- Spoken follow-ups get direct answers.
- The task does not disappear just because no screen is currently visible.
- Strong task switch language produces a cautious confirmation or recapture suggestion.

When no screen task exists:

- A clear spoken technical question gets a useful task-like answer.
- The response should be concise enough for live use.
- Jarvis should not require a screenshot to help with voice-only interview questions.

## Validation Scenarios

Screen-seeded:

- Capture a coding question, then hear "Can you do it in O(1) space?"
- Capture a system design question, then hear "How would this scale to multiple regions?"
- Capture a field-knowledge question, then hear "Can you give a shorter answer?"

Voice-seeded:

- Hear "How would you design a rate limiter?" with no screen.
- Hear "What is the time complexity of binary search and why?" with no screen.
- Hear "Can you explain RAG and its tradeoffs?" with no screen.

Mixed:

- Hear a voice-only question, then capture a code snippet or written requirement.
- Capture a question, then continue several follow-ups with no visible screen.
- Hear "next question" after a screen task and verify Jarvis does not silently reuse stale context.

Negative tests:

- Weak filler speech should not trigger a full answer.
- Ambiguous task-switch speech should not automatically clear the active task.
- Voice should not invent screen content when no screen exists.

## Metrics To Watch

Use persisted Debug Mode metrics and manual notes:

- Transcript-to-first-token latency.
- Speech-end-to-final-transcript latency.
- Partial-transcript availability if/when streaming STT exists.
- Advisor completion latency.
- Regenerate frequency.
- Manual clear frequency.
- Stale task incidents.
- Missed follow-up binding incidents.
- Voice-only useful answer rate.
- Task-switch confirmation usefulness.
- Transcript cleanup errors, especially mistranscribed technical terms, translated code-mixed speech, or rewritten speaker intent.

## Risks

- Prompt-level fusion may be inconsistent.
- Voice-only questions may be under-specified compared with screen questions.
- Keeping `ActiveScreenTask` in code while designing `ActiveMeetingTask` conceptually can create naming mismatch.
- Too much caution around task switching may leave stale context active.
- Too little caution around task switching may interrupt a real task block.

## Open Questions

- When should voice-seeded tasks become first-class persisted state?
- Should a suspected task switch render quick actions such as `Same task`, `New task`, and `Dismiss`?
- Should task block duration remain governed by the existing active task timeout, or should voice activity refresh it?
- Should the latest transcript turn show whether it was bound to the active task?
- Which failures justify adding a separate classifier model call despite latency cost?
- Which failures justify prioritizing realtime STT before `ActiveMeetingTask` state migration?
- Should transcript cleanup have a dedicated provider prompt, or should it remain purely provider/STT output for now?

## Low-Level Implementation Brief

### Goal

Improve the existing advisor path so Jarvis handles interview-like task continuity with no new model call and no data-model migration.

The implementation should make two current flows smarter:

- `screen-anchored`: a transcript turn arrives while `activeScreenTask` exists.
- `live`: a transcript turn arrives with no active screen task.

### Background

Current code path:

1. System audio produces a final `them` transcript turn.
2. `useMeetingAssistant.ts` appends the turn to `MeetingContextManager`.
3. `scheduleAdvisor()` chooses `screen-anchored` if `contextState.activeScreenTask` exists, otherwise `live`.
4. `runAdvisor()` builds `AdvisorPromptContext`.
5. `AdvisorEngine.streamSuggestion()` calls `buildAdvisorSystemPrompt()` and `buildAdvisorUserMessage()`.
6. Model output streams into `partialSuggestion`, then becomes `latestSuggestion`.
7. If mode is `screen-anchored`, final output updates `activeScreenTask.content` and refreshes its expiry.

This means the first slice can stay mostly inside `src/lib/meeting/advisor-prompt.ts`. The hook already routes transcript turns into the right broad mode, and the active screen task lifecycle already exists.

### Files And Ownership

Primary file:

- `src/lib/meeting/advisor-prompt.ts`

Expected edits:

- Strengthen `buildAdvisorSystemPrompt()` with interview task-session assumptions.
- Add explicit STT boundary language: transcript text is literal input, not an answer or task classifier.
- Add screen/voice fusion instructions for `screen-anchored` mode.
- Add voice-only technical-question instructions for normal `live` mode when no active screen task exists.
- Keep output labels compatible with existing UI parsers.

Secondary files, only if needed:

- `src/lib/meeting/advisor-engine.ts`
  - Only touch if suggestion kind inference or output normalization is clearly wrong after prompt changes.
- `src/hooks/useMeetingAssistant.ts`
  - Avoid changes in the first pass unless the current trigger behavior blocks validation.
- `src/lib/meeting/types.ts`
  - Do not add `ActiveMeetingTask` yet.

Docs:

- Update this brief and task tracking after implementation and testing.

### Prompt Contract Changes

System prompt additions:

- Treat the meeting as one-on-one and task-block oriented by default.
- The other speaker is usually asking, constraining, or following up on the task.
- The user is usually expected to solve or respond.
- A task can be screen-seeded, voice-seeded, or mixed.
- First strong task signal creates the task; later speech usually steers it.
- Do not invent screen content, speakers, hidden constraints, or task switches.
- Keep transcription and advising separate.

`screen-anchored` mode additions:

- Internally interpret latest transcript as one of:
  - `constraint`
  - `follow-up`
  - `correction`
  - `strong-task-switch`
  - `low-value`
- Do not print that classification unless it helps the answer.
- For `constraint`, update the current answer or complexity/approach.
- For `follow-up`, answer the follow-up directly using the active screen task as context.
- For `correction`, acknowledge the corrected constraint and revise the answer.
- For `strong-task-switch`, do not silently reuse or clear the old task. Return a click-answerable `Clarifying question`, such as whether to treat this as a new task.
- For `low-value`, avoid re-solving. Return a stable compact response or `-` when appropriate.

`live` mode additions with no active screen task:

- If the latest transcript is a clear technical question, treat it as a voice-seeded task moment.
- Produce useful help even without a screenshot.
- Prefer the existing compact format:
  - `Meaning`
  - `Reply`
  - `Question`
- `Meaning` should summarize the technical ask in Chinese.
- `Reply` should be a concise meeting-ready English answer or response direction.
- `Question` should be a safe clarifying question only if a missing constraint matters.
- If the turn is filler, logistics, or ambiguous chatter, output `-`.

### Constraints

- Do not add a classifier model call.
- Do not rename or migrate `ActiveScreenTask`.
- Do not introduce persisted voice task state in this slice.
- Do not automatically clear active tasks from speech alone.
- Do not change STT provider behavior.
- Do not persist raw transcript, raw model output, audio, or screenshots.
- Do not degrade the existing screen-task answer contract.
- Keep latency roughly unchanged except for normal prompt length overhead.

### Concrete Outputs

Code outputs:

- Updated advisor prompt logic for interview task fusion.
- Existing UI output formats continue to render without parser changes.
- Screen-seeded follow-ups and constraints produce direct updated answers.
- Voice-only technical questions produce useful task-like suggestions.
- Suspected task switches produce cautious click-answerable clarifying questions instead of stale answers.

Documentation outputs:

- Update task tracking with implementation status and validation notes.
- Update this brief if implementation discovers a scope adjustment.

Verification outputs:

- `npm run build`.
- `git diff --check`.
- `cargo check` only if Rust/Tauri files are touched, or before a broader release-style commit.

### Manual Validation Matrix

Use these before committing:

| Scenario | Expected behavior |
|---|---|
| Screen coding task, then "Can you do it in O(1) space?" | `screen-anchored` answer revises approach/complexity against the same task |
| Screen system design task, then "How would this scale to multiple regions?" | Answer focuses on scale follow-up without losing original task |
| Screen task, then "next question" | Jarvis asks whether to treat it as a new task or suggests recapture; it does not silently reuse stale context |
| No screen task, "How would you design a rate limiter?" | `live` response gives a concise useful answer direction |
| No screen task, "What is the time complexity of binary search?" | `live` response answers directly and briefly |
| Filler/logistics speech | Jarvis returns `-` or minimal help, not a full technical answer |
| Code-mixed technical speech | Jarvis preserves technical terms and does not translate away the ask |

### Cut Line For This Slice

Stop after prompt-level behavior is improved and validated. If tests reveal deeper issues, record them for later rather than expanding scope mid-slice.

Move to the later `ActiveMeetingTask` / realtime STT workstreams only if one of these is clearly true:

- Voice-seeded tasks need durable state across many turns.
- Prompt-only switch detection repeatedly misbinds tasks.
- Transcript latency or technical-term accuracy is the dominant failure.

## Recommended First Slice

Implement prompt-level interview task fusion.

Expected code areas:

- `src/lib/meeting/advisor-prompt.ts`
- `src/lib/meeting/advisor-engine.ts` if output handling needs small adjustments.
- `src/hooks/useMeetingAssistant.ts` only if trigger behavior needs a narrow change.
- Meeting docs and task tracking.

Acceptance criteria:

- No new model call is added.
- Screen-seeded tasks handle spoken constraints and follow-ups more directly.
- Voice-only technical questions receive task-like help.
- Strong task-switch language is handled cautiously.
- STT/transcript text remains literal input to the advisor rather than an answer-like artifact.
- Existing screen capture answer quality does not regress.
- `npm run build`, `cargo check`, and `git diff --check` pass before commit.
