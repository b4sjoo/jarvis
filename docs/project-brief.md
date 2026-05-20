# Jarvis Project Brief

## North Star

Jarvis should help the user feel faster, calmer, and more capable in real software engineering meetings.

The product is successful when, under meeting pressure, it can quickly and quietly help the user understand a technical discussion or screen-shared question, then produce a relevant answer or response direction before the user needs to speak.

This phase should optimize for meeting-time confidence and response speed, not for adding more surface area.

## Current Phase

Phase 2 focuses on performance and user experience tuning.

The MVP is already usable after self-testing and informal meeting testing. Core flows are in place:

- System audio to transcript.
- Transcript to live advice.
- Active-window screen capture to screen-anchored technical answers.
- Meeting audio as clarification or follow-up context for the active screen task.
- Manual task clearing and configurable task memory.
- Emergency hide through the existing hide/show shortcut.

## Evaluation Target

Primary evaluation target: Critical Moment Success Rate.

A critical moment is a meeting moment where the user needs to understand, answer, clarify, or respond to a technical point. Jarvis succeeds when it provides a relevant, trustworthy, and usable suggestion before the user needs to speak.

## Objectives

### 1. Speed

Jarvis should respond quickly enough to be useful during live conversation.

Target signals:

- Transcript suggestion appears quickly after a colleague finishes speaking.
- Screen capture produces a useful answer before the discussion moves on.
- Streaming begins early enough that partial output is useful.
- Slow provider calls do not freeze the overlay.

Candidate metrics:

- Transcript-to-first-suggestion latency.
- Screen-capture-to-first-token latency.
- Screen-capture-to-useful-answer latency.
- Full answer completion latency.

### 2. Answer Quality

Jarvis should answer the actual question in front of the user, not provide generic explanations.

Target signals:

- Screen answers identify the real visible question.
- Voice clarification changes or constrains the answer correctly.
- Coding answers include algorithm idea, Python by default, implementation, time complexity, and space complexity.
- Field-knowledge answers are concise and professional enough to say in a meeting.
- Clarifying questions are rare, specific, and actionable.

Candidate metrics:

- Correct question detection rate.
- Useful first answer rate.
- Manual rewrite effort after Jarvis response.
- Hallucinated speaker/context rate.

### 3. Low Friction

Jarvis should reduce meeting load rather than create more things to manage.

Target signals:

- Common actions take one shortcut or one click.
- The user does not need to drag, resize, or horizontally scroll the panel.
- Clear task, regenerate, shorter, and clarifying-answer controls are easy to use under pressure.
- Emergency hide works reliably without stopping audio capture.

Candidate metrics:

- Number of interactions needed per critical moment.
- UI interruption incidents per meeting.
- Emergency hide success rate.
- Layout or cursor regressions per test session.

### 4. Context Reliability

Jarvis should preserve useful context without letting stale context pollute new questions.

Target signals:

- Active screen task stays attached during relevant follow-up.
- New captures replace old tasks cleanly.
- Manual clear and task timeout prevent stale carryover.
- Transcript-only advice is not incorrectly forced into an old screen task.

Candidate metrics:

- Stale active task incidents.
- Missed follow-up binding incidents.
- Correct task replacement rate.
- User-initiated clear task frequency.

### 5. Meeting Safety

Jarvis should stay quiet, stable, and privacy-conscious during real meetings.

Target signals:

- The overlay can be hidden quickly.
- The app does not steal excessive focus or cursor control.
- CPU and memory remain acceptable during long sessions.
- Raw audio and screenshots are not persisted by default.
- Visibility limits are documented without promising guaranteed invisibility.

Candidate metrics:

- CPU and memory over a 60-minute session.
- Audio capture stability over a 60-minute session.
- Zoom, Google Meet, and Teams smoke-test pass rate.
- Permission recovery success rate.

## Initial Scenario Suite

Use a small repeated scenario set before major prompt, UI, or provider changes.

- Field-knowledge screen question in a notes/editor window.
- Coding or algorithm screen question in a VSCode-like window.
- Screen question with a spoken clarification.
- Screen question followed by a spoken follow-up.
- Multiple visible questions where one is visually emphasized.
- Stale task switch: old question cleared, new question captured.
- Long model response that must wrap cleanly.
- Emergency hide during an active meeting session.
- Zoom active-window sharing case.
- Audio-only discussion with no screen task.

## Near-Term Tuning Priorities

1. Add lightweight latency and resource instrumentation.
2. Measure answer speed and usefulness against the scenario suite.
3. Tune prompts and response formatting based on repeated failures.
4. Improve screen focus selection for multiple-question or noisy screens.
5. Continue Zoom first, then Google Meet and Teams validation.

## Observability Scope

Phase 2 begins with an in-memory trace layer for the two critical workflows:

- Screen workflow: shortcut or button trigger, capture command, capture metadata, model request, first-token timing, model completion, parsed screen-task state update, and final UI-ready output.
- Voice workflow: speech event, audio blob creation, STT request, transcript append, advisor debounce, advisor model request, first-token timing, model completion, and final suggestion.

Trace data should include timing, provider IDs, prompt text, raw model/STT text output, and non-sensitive metadata such as image size or capture target. It should not store raw audio bytes or raw screenshots by default.

The first observability pass found and fixed two concrete screen workflow bottlenecks:

- Duplicate hotkey events could launch overlapping screen traces and produce cancelled empty model outputs.
- Native image optimization and oversized PNG payloads could dominate end-to-end latency.

Current screen-context captures use single-flight execution, native sub-step timings, 2048px JPEG payloads, and media-type-aware provider requests. The latest user trace reached about 7.5 seconds end-to-end with first token about 4.5 seconds after trigger, which is usable enough to continue tuning answer compactness and quality.

## Deferred: Knowledge / Memory Base

Knowledge and memory are valuable for answer quality and context reliability, but they should follow the observability pass. The first useful version should stay lightweight:

- User profile memory.
- Work summary memory.
- Field knowledge and glossary entries.
- Prompt-time injection before adding embeddings or semantic cache.

Full retrieval, embeddings, and cache behavior should wait until trace data shows where personalization would most improve critical moments.
