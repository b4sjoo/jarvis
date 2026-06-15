# The System Design Evolution of Jarvis: Putting AI Inside a Runtime for Critical Moments

Jarvis started with a simple-sounding request: build a meeting assistant that stays out of screen sharing, listens to meeting audio, reads shared screens, and gives real-time suggestions.

That description looks like a feature list. If implemented literally, it leads to a common prototype: capture audio, capture screenshots, send both to a model, and show a summary. It demos well. It breaks down quickly in real meetings.

The hard part is not producing an answer. The hard part is helping the user in the few seconds before they need to speak. At that moment, the assistant has to understand what was asked, choose the right task frame, decide which context is trustworthy, avoid stale or misleading memory, and produce something the user can naturally say.

That is how Jarvis evolved from a meeting helper into a private critical-moment assistant. Its job is to help a non-native speaker in high-pressure technical conversations understand the question, choose a response direction, and start speaking without obvious waiting, reading, or context confusion.

This article summarizes the system design path behind Jarvis. It focuses on the product logic and engineering decisions rather than individual prompts or UI tweaks: what belongs to AI, what belongs to runtime architecture and code, what tradeoffs were made for the north star, and how evaluation infrastructure changed the way the product evolved.

## From Feature List To Critical Moment

The initial requirements map to three capabilities:

- capture meeting audio.
- capture the current screen.
- generate real-time advice.

Those capabilities are necessary, but they do not define the product. The real design questions are sharper:

- When should Jarvis intervene?
- What should it produce: an answer, a reasoning direction, a clarification, or silence?
- Which input source wins when screen, audio, memory, and old transcript disagree?
- How does the user recover when Jarvis is wrong?

Early on, we kept the Tauri + Rust + React architecture instead of rewriting the app in Swift. That was a product decision as much as an engineering decision. Rust owned system-level capabilities: system audio, VAD, screen capture, shortcuts, window behavior, and visibility controls. TypeScript owned providers, prompt orchestration, meeting state, UI, traces, and debug surfaces.

The first runtime looked roughly like this:

```text
Rust native capture
  -> audio segments / screen capture / window control
  -> TypeScript meeting runtime
  -> STT / vision-capable LLM / advisor LLM
  -> overlay UI
```

That architecture was enough to prove the core loop. It also revealed the main design risk: if every screenshot, transcript, memory entry, and old answer gets dumped into a prompt, the model becomes responsible for runtime policy. That is too much responsibility for an LLM.

Models are good at fuzzy semantic interpretation and natural language generation. They are not the right place to own session boundaries, task identity, memory permissions, fact provenance, cache lifetimes, or evaluation joins. Jarvis matured by moving those responsibilities into code and schema.

## Screen As Task Anchor, Audio As Constraint

The first major shift happened in the screen workflow. The early version could analyze a screenshot. In a real meeting, that was not enough. The screen might contain multiple questions, an IDE, a browser tab, a notes file, examples, distractors, and a programming language selector. The user did not need a description of the screen. The user needed help with the question they were working on.

The screen workflow became a screen-anchored technical answer contract: the screenshot is the primary source of truth, and Jarvis should answer the main visible technical question. Recent audio is supplemental clarification, constraint, or follow-up. It should not override visible screen content.

That decision introduced a source-of-truth hierarchy:

```text
visible screen question
  > latest interviewer clarification
  > explicit user correction
  > interview brief
  > curated memory
  > old transcript
  > model-generated text
```

The goal was not to make the model think harder. The goal was to reduce the amount it had to guess. Code captured the active window, cursor metadata, focus band, image payload, and capture target. The model used those inputs to identify the main question and generate a structured answer.

Several improvements followed from that principle:

- Active-window capture replaced whole-screen guessing.
- Cursor-centered horizontal focus bands helped anchor the model near the user's current target.
- Jarvis sent both the focus image and full active-window image, so it kept local focus and global context.
- Oversized PNG payloads became optimized JPEG payloads.
- Screen outputs became structured sections: `Answer`, `Approach`, `Code`, `Complexity`, and clarification.
- Coding artifacts became cached UI artifacts, so non-coding follow-ups would not erase the code and complexity sections.

The reusable lesson is that multimodal AI systems need input roles. Screen, interviewer audio, user microphone, interview brief, memory, and old transcript cannot all be treated as equal context. Their authority needs to be explicit.

## Voice: Ordering And Boundaries Before Full Realtime

The voice path had a similar evolution. The ideal meeting assistant would use streaming STT and partial transcripts. Jarvis initially chose VAD-based speech segments with request/response STT.

That choice traded some immediacy for control. A complete audio segment could be transcribed, appended as a final turn, and then passed through advisor gating. This was easier to reason about than partial transcripts arriving continuously. In the early reliability phase, the biggest risk was not being one second late. The biggest risk was stale STT results from an old session polluting a new one, or concurrent audio requests appending transcript out of order.

A later code review made this concrete: `speech-detected` handlers could fire without proper queueing, old STT results could arrive late, and transcript order could drift. The fix was not a better model. It was runtime guardrails: audio segment FIFO, sequence IDs, session IDs, and stale-result drops.

This became the second engineering principle: in a realtime AI system, ordering and ownership belong to code. The LLM can understand what an utterance means. It should not decide which session, segment, or parent task owns that utterance.

The same principle shaped microphone-side context fusion. In real interviews, the user may ask a quick confirmation: “When you say RAG, you mean Retrieval-Augmented Generation, not recommendation system, right?” The interviewer may answer “right.” If Jarvis only listens to the other side, it misses the actual correction. If it shows everything the user says in the main transcript, it distracts the user from the interviewer.

The final design split the behavior:

- Normal and Focus UI show only `them` transcript.
- `me` transcript appears only in Debug and trace surfaces.
- `me` turns enter advisor context only when they match quantitative rules: short clarification, close timing, similar text, and later confirmation from `them`.
- Raw `me` transcript can be recorded locally for debugging, but it is not a fact anchor.

The AI role is to understand a correction such as “RAG, not rec.” The runtime role is to decide whether that correction is admissible context, and whether it is a clarification, correction, or attempted answer.

## From Answer Generation To Task Trajectory

Jarvis became much more useful after the target scenario narrowed from generic meetings to one-on-one remote interviews and interview-like technical discussions.

That constraint made the product tractable:

- The other person is usually the questioner.
- The user is usually the solver.
- A task block often lasts 15 to 30 minutes.
- The conversation usually stays around one problem, with constraints and follow-ups.

This shifted Jarvis from answer generation to trajectory support.

A coding task needs problem understanding, algorithm choice, implementation, complexity, and follow-up modifications. A general system design task needs requirement clarification, QPS estimation, API/data model, architecture, bottlenecks, and tradeoffs. An AI/ML system design task needs objective, data, model path, serving, metrics, evaluation loop, and observability. A project deep dive needs grounded project facts, design choices, tradeoffs, impact, and reflection. A behavioral question needs a real story and company-calibrated framing.

Those procedures should not be improvised entirely by a model. Jarvis introduced Interview Playbooks.

A playbook is not a knowledge base. KMB answers “what does Jarvis know?” A playbook answers “what should Jarvis do next?” It determines whether the next move should be direct answer, clarification, scale estimation, story selection, concept explanation, or context preservation.

Later mock interviews exposed another class of task: some responses should not be freshly improvised every time. Self-introduction and project introduction need light adaptation to the company, interviewer, and brief, but their core should come from prepared templates and grounded profile facts. Project deep dive also became a parent task rather than a one-shot answer type. It may contain field-knowledge, behavioral, coding, and tradeoff probes before returning to the original project thread.

The runtime pipeline became:

```text
Perception
  -> Classification
  -> Task Continuity
  -> Playbook
  -> Memory Policy
  -> Prompt / Model Route
  -> Response
  -> Evaluation
```

The model still participates in classification, interpretation, and final wording. But the critical decisions need to be schema-visible: question type, task relation, subtask intent, playbook phase, memory family, and model route. If those decisions exist only inside a prompt, they are hard to debug and nearly impossible to evaluate.

## Task Ontology: From `activeScreenTask` To `ActiveMeetingTask`

The early screen workflow used `activeScreenTask`. That was reasonable because explicit screen capture was the strongest task anchor. As Jarvis added voice-only tasks, mixed tasks, parent-child follow-ups, Focus Mode, session recording, and human evaluation, a screen-specific state object became too narrow.

Consider a realistic interview path:

```text
Parent task: AI/ML system design, design a self-improving agent
Child probe: field knowledge, what is RAG?
Child probe: coding, write a loss function
Resume parent: what metrics would prove the agent improved?
```

If “what is RAG?” becomes a new top-level task, Jarvis loses the AI/ML design trajectory. It may restart requirement clarification or treat later metrics questions as field knowledge. If every follow-up is forced into the parent, a coding probe can pollute the design prompt.

The solution was not to keep expanding `ScreenTaskKind`. The solution was to separate concepts:

- `questionType`: stable task family, such as `coding`, `general-system-design`, `ai-ml-system-design`, `project-deep-dive`, `behavioral`, or `field-knowledge`.
- `taskRelation`: how the latest input relates to the active task, such as `new-parent`, `followup-parent`, `child-probe`, `resume-parent`, or `correction`.
- `subtaskIntent`: local purpose of a child probe, such as `metric-probe`, `concept-probe`, or `implementation-probe`.
- `playbookPhase`: where the task is inside its procedure.

That led to the `ActiveMeetingTask` adapter. The first step did not delete `activeScreenTask` or `activeInterviewTask`. It created a unified view so prompts, session recording, Focus Mode, caches, model routing, and human evaluation could start reading the same parent task identity.

The migration then moved further: screen, voice, correction, manual type override, and manual next began converging around the same task identity. This adapter-first migration was a key tradeoff. Deleting old state immediately would create broad regressions. Letting every consumer read its own task state would make behavior unexplainable. Jarvis first unified the consumer boundary, then migrated writes, and only then could legacy state removal become safe.

## Memory Is A Permission Problem Before It Is A Ranking Problem

Once Jarvis moved into interview support, the Knowledge / Memory Base became valuable. The user could provide profiles, project summaries, behavioral story anchors, question banks, company interview guides, and AI/ML system design notes. Behavioral and project-specific answers became much better when grounded in real materials.

Memory also became one of the highest-risk surfaces. Wrong memory is often worse than no memory.

The first KMB implementation did not start with embeddings. It used curated Markdown, a local SQLite runtime index, and deterministic retrieval. That was intentional. With personal experience, project facts, company rubrics, and behavioral stories, the main problem is not broad semantic recall. The main problem is whether a memory entry is allowed to influence the current answer.

Jarvis therefore split retrieval into two stages:

1. Policy gate: question type, interview type, company, playbook allowed families, blocked families, required tags.
2. Ranking: keywords, tags, priority, use case, project anchor, and topic domain.

For example, Amazon Leadership Principle rubrics should appear only in Amazon behavioral questions. They should not influence AI/ML system design or project deep dives. Behavioral stories can support behavioral answers. They should not frame general system design. Project docs can provide evidence, but raw sources are not always safe to inject directly.

This later evolved into `FactAnchorDecision`:

- `strong-anchor`: a concrete memory, story, or project supports the answer.
- `weak-anchor`: related facts exist, but they do not support every requested detail.
- `no-anchor`: the system should ask a clarification or offer supported choices.
- `not-required`: coding, field knowledge, and most general system design tasks do not require a personal fact anchor.

The rule came from a real failure: the model invented a project story, the user repeated it while answering, and later behavioral answers reused that story as if it were fact. Generated content had leaked into the fact layer through transcript.

Jarvis now uses a stricter principle: generated answers are not facts. Valid fact anchors come from explicit user-provided or user-confirmed facts, curated KMB entries, visible screen facts, confirmed transcript context, or explicit manual correction.

As system design and AI/ML design became validation targets, KMB gained another role: diagram memory. Memory was no longer only text for the model to quote or summarize. It could provide reusable architecture sketches, component relationships, and whiteboard overlays. Those overlays still go through policy gates. They are injected only when the question type, domain, and playbook phase make them admissible. In that sense, memory became an artifact substrate controlled by runtime policy.

## UI Tradeoffs: Lowering Interaction Cost Under Pressure

The UI also evolved around the north star. Early Meeting Assistant panels carried many controls: configurations, debug traces, response actions, transcript, memory details, and evaluation widgets. That worked for debugging. It was too much for interviews.

Focus Mode split the surface into two windows:

- A top answer window with Answer, Chinese thinking, Code, Complexity, clarification, and latest reliable answer.
- A lower control window with interview type, latest transcript, speech correction, and start/pause.

Later iterations removed the main bar and icon bar in Focus Mode, added a hotkey, kept the interview type selector because it was low-friction and high-impact, removed the bilingual action, and replaced it with a permanent Chinese thinking section. The bilingual action was slow and sometimes translated only part of the response. A first-class Chinese reasoning section was more predictable.

The next shift was from hiding controls to making long tasks controllable. System design and AI/ML design cannot be handled as one answer. They need a persistent Whiteboard artifact where requirements, components, data flow, bottlenecks, metrics, and tradeoffs can evolve. `Next` also changed meaning. It is not a regenerate button. It is a low-friction way for the user to advance the playbook phase: the runtime commits `manualPhaseFrom -> manualPhaseTo`, then the model generates from the new state.

The UI lesson is that high-pressure contexts need fewer controls and better control points. Debug Mode can carry complexity. Focus Mode should carry only the surfaces and actions that help the user speak sooner or steer the trajectory.

## Evaluation Infrastructure Is Product Infrastructure

The largest late-stage change in Jarvis was not a new model. It was evaluation infrastructure.

At first, feedback sounded like: “this answer feels better” or “this run was slow.” Trace instrumentation made a single workflow visible: screen capture, audio, memory retrieval, prompt input, first token, raw output, state update, and latency. It could answer what happened in one call chain.

Session Recording changed the evaluation object from a single trace to an entire mock interview. A session records transcripts, screenshots, prompts, raw outputs, memory artifacts, task snapshots, compact metrics, and human evaluation. That makes it possible to review a trajectory rather than a single answer.

Human Evaluation v2 added the missing human judgment layer. Instead of labeling a whole trace as good or bad, it can label a question:

- whether the question type was correct.
- whether the playbook was correct.
- whether the phase was useful.
- whether each memory entry was relevant, irrelevant, or forbidden.
- whether expected memory was missing.
- whether the guardrail was correct.
- whether the answer helped.

This moved Jarvis from prompt tuning by intuition to failure analysis by evidence chain.

The next step was a task-level review index. `tasks/review-index.latest.json` and `tasks/<taskId>/review-summary.json` join compact trace summaries and question-level labels through stable task, parent, child, and trace IDs. Review can now ask better questions: which phases did this parent task go through, did `Next` advance anything, when did the Whiteboard become stale, which overlay was selected or rejected, and which human label maps to which runtime layer?

A session review can now attribute failures by layer:

- perception: wrong window, wrong screen target, or STT error.
- classification: wrong question type or target company.
- task continuity: stale task, lost parent-child relation, or low-value speech refresh.
- memory policy: over-injection, missing memory, or forbidden memory hit.
- fact grounding: unsupported story or failed no-anchor fallback.
- playbook: wrong phase or missing clarification.
- model route: coding route used for non-coding, or weak model used for coding.
- response rendering: markdown, code, math, or parser failure.

That changed the roadmap. P0 tasks began coming from mock-interview failure patterns: context pollution, weak voice task boundaries, unsupported story reuse, shallow AI/ML metrics answers, dirty session recordings, and coarse human evaluation labels. The product loop became: record the session, label the question, artifact, and memory, attribute the failure layer, repair the runtime contract, and validate again in the next session.

## What Belongs To AI, What Belongs To Code

The central system design lesson from Jarvis is this: give semantic uncertainty to AI, and give runtime boundaries to code.

AI should handle:

- understanding natural-language questions from screenshots and speech.
- choosing the likely active question among visible distractors.
- integrating interviewer constraints into an answer.
- producing speakable responses.
- adapting expression across coding, system design, AI/ML design, behavioral, project deep dive, and field knowledge.
- turning curated memory into concise, context-aware wording.
- turning a whiteboard overlay or project memory into wording appropriate for the current phase.

Code, schema, and runtime should handle:

- current active task identity.
- relation between the latest input and the active task.
- memory family admission.
- whether generated output can become fact.
- provider and model route.
- timeout policy.
- coding artifact and latest reliable answer lifecycle.
- session recording boundaries and join keys.
- trace metrics, human evaluation, and hard-reject telemetry.
- metadata contracts for intermediate artifacts such as Whiteboard, Manual Next, and diagram overlays.
- Debug Mode and Focus Mode display rules.
- visibility, shortcuts, windows, capture targets, and audio segment order.

This boundary does not reduce the role of AI. It makes AI useful in the right place. The stronger the model, the more important it becomes to define which facts it may trust, what task it is solving, which process it should follow, and which inferences are forbidden.

## Tradeoffs Made For The North Star

Jarvis optimizes for critical moment success: relevant, trustworthy, usable help before the user needs to speak. That led to several concrete tradeoffs.

**Manual hotkey before automatic observation.** Automatic screen observation sounds smarter, but before task boundaries and evaluation corpora are reliable, it amplifies false triggers and context pollution. Manual screen capture gives the user a clear task-start signal and makes traces easier to review.

**Final STT before streaming rewrite.** Streaming STT can be faster. It also introduces more ways for partial, low-confidence text to pollute context. Jarvis first stabilized segment ordering, session guards, and stale-result drops.

**Deterministic KMB before embeddings.** Embeddings can improve recall, but the early risk was wrong memory injection. Family gates, tag hints, fact anchors, and reject telemetry had to come first.

**Short useful guidance before complete long scripts.** In an interview, the user needs to start speaking. For long system design tasks, Jarvis should often produce clarification questions, assumptions, and phased trajectories rather than a full guessed design.

**Template-backed openings before fresh improvisation.** Self-introduction, resume walkthrough, and core project introduction should not depend entirely on live generation. They need stable, truthful, rehearsable cores, then light adaptation to the company, interviewer, and brief.

**Whiteboard artifact before one-shot system design answer.** Long design tasks need a design state that can evolve. A Whiteboard lets requirements, components, data flow, metrics, and tradeoffs update inside the same parent task.

**Deterministic Next before model-guessed phase progression.** When the user triggers `Next`, Jarvis first advances the playbook phase in runtime state, then generates the next response. The user gets a low-friction control point instead of waiting for the model to infer that the interview should move forward.

**Focus Mode before complete configurability.** Normal mode can expose Debug and configuration. Focus Mode should minimize visual and operational cost.

**A stronger coding model only for coding.** Coding errors are expensive, and interviewers tolerate more thinking time for coding. Jarvis routes coding tasks to a stronger model with a longer timeout and larger output budget, while keeping other task types faster.

**Local personal tool before production policy system.** Because Jarvis is a personal local tool, Debug Mode can show full prompts, memory, and traces. That accelerates iteration. A broader release would require redesigned secrets storage, retention, redaction, and visibility claims.

## Conclusion

Jarvis shows that the hard part of a live AI assistant is rarely the model call itself. The hard part is the runtime around the model.

The model understands and writes. The architecture owns boundaries, state, evidence, and recovery. The code makes every answer traceable to task identity, fact sources, memory policy, model route, UI lifecycle, and evaluation data.

For a live assistant, single-answer quality is only the surface. The deeper product question is whether the system can preserve a useful trajectory across a conversation: when to answer, when to clarify, when to keep the parent task, when to enter a child probe, when to reject unsupported memory, when to preserve code, and when to stay quiet.

That is the logic behind Jarvis’s evolution from a meeting assistant into a critical-moment assistant. The product did not mature by handing more decisions to AI. It matured by placing AI inside a clearer system boundary, so it could be genuinely useful at the moment the user needed it.
