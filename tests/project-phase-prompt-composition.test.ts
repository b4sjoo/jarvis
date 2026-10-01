import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvisorSystemPrompt, buildAdvisorUserMessage } from "../src/lib/meeting/advisor-prompt.js";
import { buildActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { applyActiveBranchPhase, resolveEffectiveBranchPhase } from "../src/lib/meeting/active-branch-phase.js";
import { buildFactAnchorDecision, PROJECT_FACT_RESPONSE_BOUNDARY } from "../src/lib/meeting/fact-anchor-guardrail.js";
import { selectInterviewPlaybook } from "../src/lib/meeting/interview-playbook.js";
import {
  applyPlaybookPhaseDecisionToProgress,
  decideManualNextPhaseTransitionForBranch,
  decidePlaybookPhaseProgression,
  formatProjectDeepDivePhaseContract,
} from "../src/lib/meeting/playbook-phase.js";
import type { PlaybookPhaseDecision } from "../src/lib/meeting/playbook-phase-contracts.js";
import {
  buildProjectMainlinePhaseAdmission,
  type ProjectMainlinePhaseAdmissionInput,
} from "../src/lib/meeting/project-mainline-phase-admission.js";
import {
  appendCommittedManualNextPhaseTransition,
  createPlaybookPhaseHistoryState,
  decideManualPlaybookPhaseBack,
} from "../src/lib/meeting/playbook-phase-history.js";
import { createSourceOwnedTransitionCandidate, prepareSourceOwnedTransition } from "../src/lib/meeting/source-owned-transition-transaction.js";
import { SCREEN_TASK_SYSTEM_PROMPT } from "../src/lib/meeting/screen-task-system-prompt.js";
import type { ActiveInterviewParent, MeetingResponseConfig, MeetingResponseActionMode } from "../src/lib/meeting/types.js";
import { loadScreenTaskPromptBuilder } from "./helpers/screen-task-prompt-builder.js";

// Prompt/phase composition only. Real ingress/settlement recognition and the
// hook's original-operation lease remain caller tests; no model is invoked.
const buildScreenMessage = loadScreenTaskPromptBuilder();
const introQuestion = "Introduce the parser project and your own contributions.";
const technicalQuestion = "Why did your parser use NDJSON and how did you validate partial records?";

function makeParent(): ActiveInterviewParent {
  const playbook = selectInterviewPlaybook({ questionType: "project-deep-dive", query: introQuestion });
  assert.ok(playbook);
  return {
    id: "P", source: "voice", stableKind: "project-deep-dive", topic: "Parser project",
    playbook, playbookPhase: playbook.phase, phaseProgress: { [playbook.phase]: true },
    supportedFactAnchors: [], revisions: 1, createdAt: 1, updatedAt: 1,
  };
}

function phaseDecision(parent = makeParent(), event?: ReturnType<typeof buildProjectMainlinePhaseAdmission>) {
  return decidePlaybookPhaseProgression({
    questionType: "project-deep-dive", playbookId: "project_deep_dive",
    currentPhase: parent.playbookPhase, phaseProgress: parent.phaseProgress,
    relation: "followup-parent", projectMainlineAdmission: event,
  });
}

function admission(overrides: Partial<ProjectMainlinePhaseAdmissionInput> = {}) {
  return buildProjectMainlinePhaseAdmission({
    logicalQuestionUnit: { id: "Q1", sessionId: "session" },
    effectiveRecords: [{ sessionId: "session", logicalQuestionUnitId: "Q0", owner: { kind: "parent-mainline", parentId: "P" } }],
    parentId: "P", responseOwner: { kind: "parent", parentId: "P" },
    source: "live-turn", authorized: true, ...overrides,
  });
}

function compose(parent: ActiveInterviewParent, decision: PlaybookPhaseDecision, question: string, options: {
  responseConfig?: MeetingResponseConfig;
  responseAction?: MeetingResponseActionMode;
} = {}) {
  const activeMeetingTask = buildActiveMeetingTask({ parent, runtimeRevision: parent.revisions });
  assert.ok(activeMeetingTask);
  const owner = resolveEffectiveBranchPhase(parent);
  assert.equal(owner.status, "resolved");
  if (owner.status !== "resolved") throw new Error("expected committed response owner");
  const interviewPlaybook = owner.view.playbook;
  const factAnchorDecision = buildFactAnchorDecision({
    questionType: interviewPlaybook.questionType, questionText: question,
    personalEvidenceGuardrailMode: "enforcement",
  });
  const context = {
    transcript: `Them: ${question}`, screenContext: "",
    taskRuntime: { revision: parent.revisions, parent }, activeMeetingTask, interviewPlaybook,
    playbookPhaseDecision: decision, factAnchorDecision,
    currentQuestionProjection: { answerFocusText: question, semanticEvidenceText: question, sourceTurnIds: ["current-turn"] },
  };
  const responseConfig = options.responseConfig ?? { length: "short", language: "english" };
  return {
    voice: buildAdvisorUserMessage(context, {
      responseConfig, mode: options.responseAction ? "response-action" : "live",
      responseAction: options.responseAction, currentSuggestion: "Answer:\nPrevious generated answer is not fact evidence.",
    }),
    voiceScreenAnchored: buildAdvisorUserMessage(context, { responseConfig, mode: "screen-anchored" }),
    screen: buildScreenMessage({
      observation: { id: "observation", capturedAt: 1, summary: question },
      recentTranscript: question, screenPreflight: { question, questionType: interviewPlaybook.questionType },
      interviewPlaybook, playbookPhaseDecision: decision, activeMeetingTask, factAnchorDecision, responseConfig,
    }),
  };
}

function section(prompt: string, tag: string) {
  const start = prompt.indexOf(`<${tag}>\n`);
  const end = prompt.indexOf(`\n</${tag}>`, start);
  assert.ok(start >= 0 && end > start, `composed ${tag} section`);
  return prompt.slice(start + tag.length + 3, end);
}

function assertSummary(prompt: string) {
  assert.ok(section(prompt, "playbook_phase_state").includes(formatProjectDeepDivePhaseContract("project_summary")));
  assert.match(prompt, /Answer: a grounded 3-5 minute/);
  for (const part of ["1. Background and scale", "2. My concrete responsibilities", "3. Architecture and tradeoffs", "4. Retrospective and redesign"]) {
    assert.ok(section(prompt, "playbook_phase_state").includes(part), part);
  }
  assert.match(prompt, /Required artifacts this phase: answer\n/);
  assert.match(prompt, /phase contract overrides general short-answer/);
  assert.doesNotMatch(prompt, /^Answer: one to three /m);
  assert.doesNotMatch(prompt, /30-45 second/);
}

test("PS1 actual Voice and Screen composition uses one four-part grounded Summary in Answer", () => {
  for (const language of ["english", "chinese"] as const) {
    const prompts = compose(makeParent(), phaseDecision(), introQuestion, { responseConfig: { length: "short", language } });
    for (const prompt of Object.values(prompts)) {
      assertSummary(prompt);
      assert.match(prompt, /requested meeting language/);
      assert.match(prompt, /Never invent scale, metrics, ownership/);
      assert.match(prompt, /not a timer or word quota/);
      assert.match(prompt, /do not duplicate the Summary/);
      assert.ok(prompt.includes(PROJECT_FACT_RESPONSE_BOUNDARY));
      assert.ok(prompt.includes(introQuestion));
      assert.match(prompt, language === "chinese" ? /concise Chinese/ : /meeting-ready English/);
    }
  }
  assert.match(buildAdvisorSystemPrompt(), /except when the response playbook explicitly selects project_summary/);
  assert.doesNotMatch(SCREEN_TASK_SYSTEM_PROMPT, /30-45 second/);
});

test("PS1 first technical LQU retains Summary phase while the composed prompt prioritizes its explicit ask", () => {
  const parent = makeParent();
  const decision = decidePlaybookPhaseProgression({
    questionType: "project-deep-dive", currentQuestion: technicalQuestion, freshParentCreated: true,
  });
  assert.equal(decision.phase, "project_summary");
  for (const prompt of Object.values(compose(parent, decision, technicalQuestion))) {
    assert.ok(prompt.includes(technicalQuestion));
    assert.match(prompt, /explicit technical question directly, even on the first LQU/);
    assert.match(prompt, /default introduction must not override it/);
    assert.match(prompt, /Manual Next\/Back phase-continuation intent takes priority over the reused old LQU wording/);
  }
});

test("PS2 new mainline admission commits QA before both production Prompt builders consume it", () => {
  for (const source of ["voice", "screen"] as const) {
    const parent = makeParent();
    const event = admission({ source: source === "voice" ? "live-turn" : "manual-screen" });
    const decision = phaseDecision(parent, event);
    assert.equal(decision.action, "advance");
    const candidate = createSourceOwnedTransitionCandidate({
      sessionId: "session", runtimeEpoch: 1, source,
      sourceTurnIds: source === "voice" ? ["Q1-turn"] : [],
      sourceObservationIds: source === "screen" ? ["Q1-screen"] : [],
      logicalQuestionUnitId: "Q1", logicalQuestionRevision: 1, existingTask: parent,
      relation: "followup-parent", authoritySource: "settled-source", mutationAuthorized: true,
      questionType: "project-deep-dive", question: technicalQuestion, playbook: parent.playbook, phaseDecision: decision,
    });
    assert.ok(candidate);
    const committed = prepareSourceOwnedTransition({ candidate, currentTask: parent, currentSessionId: "session", currentRuntimeEpoch: 1 });
    assert.equal(committed.mutationApplied, true);
    assert.equal(committed.task?.playbookPhase, "project_QA");
    assert.ok(committed.task);
    for (const prompt of Object.values(compose(committed.task, decision, technicalQuestion))) {
      assert.match(section(prompt, "interview_playbook"), /phase: project_QA/);
      const phase = section(prompt, "playbook_phase_state");
      assert.match(phase, /In project_QA, directly answer the current question/);
      assert.match(phase, /explicitly requested overview or retrospective is still a valid current answer/);
      assert.doesNotMatch(phase, /3-5 minute/);
      assert.doesNotMatch(prompt, /^Answer: a grounded 3-5 minute/m);
      assert.ok(prompt.includes(technicalQuestion));
      assert.match(phase, /Required artifacts this phase: answer\n/);
    }
    assert.equal(phaseDecision(committed.task, event).action, "stay");
  }
});

test("PS4 a real Coding child response owner does not inherit its PDD parent's long Summary", () => {
  const parent = makeParent();
  const coding = selectInterviewPlaybook({ questionType: "coding" });
  const candidate = createSourceOwnedTransitionCandidate({
    sessionId: "session", runtimeEpoch: 1, source: "voice", sourceTurnIds: ["child-turn"],
    existingTask: parent, relation: "child-probe", authoritySource: "settled-source", mutationAuthorized: true,
    questionType: "coding", question: "Implement the parser.", playbook: coding, subtaskIntent: "implementation-probe",
  });
  assert.ok(candidate);
  const committed = prepareSourceOwnedTransition({ candidate, currentTask: parent, currentSessionId: "session", currentRuntimeEpoch: 1 });
  const withChild = committed.task;
  assert.ok(withChild?.child?.phaseState);
  assert.equal(withChild.playbookPhase, "project_summary");
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding", currentPhase: withChild.child.phaseState.phase, playbookId: "coding_algorithm",
  });
  for (const prompt of Object.values(compose(withChild, decision, "Implement the parser."))) {
    assert.match(section(prompt, "interview_playbook"), /phase: implementation_validation/);
    assert.match(prompt, /Required artifacts this phase: answer, code, complexity/);
    assert.doesNotMatch(prompt, /projectDeepDivePhaseContract:|3-5 minute|four parts inside the existing Answer/);
  }
});

test("PS6 real Next/Back decisions control Prompt phase despite reused old question wording", () => {
  const parent = makeParent();
  const beforeOwner = resolveEffectiveBranchPhase(parent);
  assert.equal(beforeOwner.status, "resolved");
  if (beforeOwner.status !== "resolved") throw new Error("missing owner");
  const next = decideManualNextPhaseTransitionForBranch({
    ownerKind: "parent", questionType: "project-deep-dive", currentPhase: parent.playbookPhase, phaseProgress: parent.phaseProgress,
  });
  const advanced = applyActiveBranchPhase({
    parent, owner: beforeOwner.view, targetPhase: next.phase,
    phaseProgress: applyPlaybookPhaseDecisionToProgress(parent.phaseProgress, next, parent.playbookPhase),
  });
  assert.ok(advanced);
  const historyOwner = { kind: "parent" as const, id: parent.id, parentId: parent.id };
  const history = appendCommittedManualNextPhaseTransition(createPlaybookPhaseHistoryState(), {
    operationId: "next", owner: historyOwner, fromPhase: "project_summary", toPhase: next.phase,
    taskRevision: advanced.revisions, expectedPhaseRevision: 0, committedAt: 2,
  });
  assert.equal(history.status, "appended");
  for (const prompt of Object.values(compose(advanced, next, introQuestion, { responseAction: "next-phase" }))) {
    assert.match(prompt, /Recommended phase: project_QA/);
    assert.match(prompt, /Decision source: manual-next/);
    assert.match(prompt, /Manual Next\/Back phase-continuation intent takes priority/);
    assert.ok(prompt.includes(introQuestion));
    assert.doesNotMatch(prompt, /^Answer: a grounded 3-5 minute/m);
  }
  assert.equal(decideManualNextPhaseTransitionForBranch({
    ownerKind: "parent", questionType: "project-deep-dive", currentPhase: next.phase,
  }).guardStatus, "blocked-no-next-phase");
  const back = decideManualPlaybookPhaseBack({
    history: history.state,
    current: { owner: historyOwner, currentPhase: next.phase, taskRevision: advanced.revisions, phaseRevision: 1 },
    request: { operationId: "back", owner: historyOwner, expectedTaskRevision: advanced.revisions, expectedPhaseRevision: 1, requestedAt: 3 },
  });
  assert.equal(back.status, "ready");
  const currentOwner = resolveEffectiveBranchPhase(advanced);
  if (back.status !== "ready" || currentOwner.status !== "resolved") throw new Error("missing Back target");
  const restored = applyActiveBranchPhase({
    parent: advanced, owner: currentOwner.view, targetPhase: back.targetPhase, phaseProgress: advanced.phaseProgress,
  });
  assert.ok(restored);
  const sameQuestion = phaseDecision(restored, admission({ source: "response-action" }));
  assert.equal(sameQuestion.phase, "project_summary");
  const restoredPrompts = compose(restored, sameQuestion, technicalQuestion, { responseAction: "previous-phase" });
  for (const prompt of Object.values(restoredPrompts)) {
    assertSummary(prompt);
    assert.match(prompt, /Manual Next\/Back phase-continuation intent takes priority/);
    assert.ok(prompt.includes(technicalQuestion));
  }
  assert.match(restoredPrompts.voice, /deterministically restored previous playbook phase/);
});

test("PS3/PS5/PS7 excluded source operations retain Summary through both Prompt builders", () => {
  const exclusions: Array<Partial<ProjectMainlinePhaseAdmissionInput>> = [
    ...(["regenerate", "response-action", "artifact-regeneration", "clarifying-answer", "manual-correction", "force-advise"] as const).map(source => ({ source })),
    { replay: true }, { projectSelection: true }, { boundVoicePrimaryAsk: true, source: "manual-screen" },
    { freshParentCreated: true }, { initializesSummary: true }, { authorized: false },
    { responseOwner: { kind: "child", parentId: "P" } }, { responseOwner: { kind: "current-only" } },
    { logicalQuestionUnit: { id: "Q0", sessionId: "session" } },
  ];
  for (const excluded of exclusions) {
    const parent = makeParent();
    const decision = phaseDecision(parent, admission(excluded));
    assert.equal(decision.phase, "project_summary", JSON.stringify(excluded));
    assert.equal(decision.action, "stay");
    for (const prompt of Object.values(compose(parent, decision, introQuestion))) {
      assertSummary(prompt);
    }
  }
});
