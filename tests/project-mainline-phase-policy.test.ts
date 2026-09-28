import assert from "node:assert/strict";
import test from "node:test";
import type {
  PlaybookPhaseDecisionInput,
  ProjectMainlinePhaseAdmission,
} from "../src/lib/meeting/playbook-phase-contracts.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import {
  decideManualNextPhaseTransitionForBranch,
  decidePlaybookPhaseProgression,
  formatPlaybookPhaseDecisionForPrompt,
  formatProjectDeepDivePhaseContract,
  resolvePlaybookState,
} from "../src/lib/meeting/playbook-phase.js";
import {
  createInterviewPlaybookFromCatalog,
} from "../src/lib/meeting/interview-playbook-catalog.js";
import { createCodingChildPhaseState } from "../src/lib/meeting/coding-child-phase.js";
import {
  buildProjectMainlinePhaseAdmission,
  type ProjectMainlinePhaseAdmissionInput,
} from "../src/lib/meeting/project-mainline-phase-admission.js";
import {
  appendCommittedAutomaticPhaseTransition,
  appendCommittedManualBackPhaseTransition,
  createPlaybookPhaseHistoryState,
  decideManualPlaybookPhaseBack,
} from "../src/lib/meeting/playbook-phase-history.js";

// These are domain policy tests, not source-admission/recognition evidence.
// Caller composition still owns real LQU provenance, RO/Type/Relation settlement,
// source/manual-action leases, receipt consumption, pre-dispatch commit, and
// Plan/UI agreement. PS9 requires separately authorized real generation.
const admission: ProjectMainlinePhaseAdmission = {
  logicalQuestionUnitId: "Q1",
  previousLogicalQuestionUnitId: "Q0",
  newQuestionAdmitted: true,
  parentId: "P",
  responseOwner: { kind: "parent", parentId: "P" },
  authorized: true,
  initializesSummary: false,
};

function decide(overrides: Partial<PlaybookPhaseDecisionInput> = {}) {
  return decidePlaybookPhaseProgression({
    questionType: "project-deep-dive",
    playbookId: "project_deep_dive",
    currentPhase: "project_summary",
    relation: "followup-parent",
    ...overrides,
  });
}

test("PS1/PS5: catalog initialization and initialization events stay Summary", () => {
  const playbook = createInterviewPlaybookFromCatalog({
    questionType: "project-deep-dive", confidence: 0.9, reason: "committed type",
  });
  assert.equal(playbook?.phase, "project_summary");
  assert.equal(resolvePlaybookState({ questionType: "project-deep-dive" }).phase, "project_summary");
  for (const input of [
    { currentPhase: undefined },
    { freshParentCreated: true },
    { currentPhase: "project_QA" as const, freshParentCreated: true },
    { currentPhase: "project_QA" as const,
      projectMainlineAdmission: { ...admission, initializesSummary: true } },
  ]) {
    const result = decide({ projectMainlineAdmission: admission, ...input });
    assert.equal(result.phase, "project_summary");
    assert.equal(result.reason, "project-summary-initialized-this-operation");
    assert.deepEqual(result.requiredArtifacts, ["answer"]);
  }
});

test("PS1/PS8: Summary contract retains facts, language, four Answer parts and interruptibility", () => {
  const prompt = formatProjectDeepDivePhaseContract("project_summary");
  for (const text of [
    "3-5 minute", "requested meeting language", "existing Answer section",
    "Background and scale", "My concrete responsibilities", "Architecture and tradeoffs",
    "Retrospective and redesign", "Never invent scale", "candidate selection and fact permissions",
    "even on the first LQU", "NDJSON", "Manual Next/Back phase-continuation intent takes priority",
    "new question may interrupt", "not a timer or word quota", "do not duplicate the Summary",
    "new top-level parser fields", "Coding child follows its own phase",
  ]) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /30-45/);
  const qa = formatProjectDeepDivePhaseContract("project_QA");
  assert.match(qa, /explicitly requested overview or retrospective/);
  assert.match(qa, /ordinary QA length contract/);
  assert.doesNotMatch(qa, /3-5 minute/);
});

test("PS2: admitted different LQU advances once and repeated committed QA remains QA", () => {
  const first = decide({ projectMainlineAdmission: admission });
  assert.equal(first.phase, "project_QA");
  assert.equal(first.action, "advance");
  assert.equal(first.phaseFrom, "project_summary");
  assert.deepEqual(first.flags, []);
  assert.deepEqual(first.completedFlags, []);
  assert.deepEqual(first.requiredArtifacts, ["answer"]);
  const afterCommit = decide({ currentPhase: first.phase, projectMainlineAdmission: admission });
  assert.equal(afterCommit.phase, "project_QA");
  assert.equal(afterCommit.action, "stay");
  assert.match(formatPlaybookPhaseDecisionForPrompt(first, undefined), /In project_QA/);
  // Generation outcome is not an input: a failed attempt cannot undo a commit.
  assert.equal(decide({ currentPhase: first.phase, currentAnswer: "generation failed" }).phase, "project_QA");
});

test("PS3: same identity and missing real admission never advance, even with a new execution", () => {
  for (const operation of ["revision", "supplement-image", "bind-voice", "selection", "regenerate", "retry", "correction", "enhance", "narrow"]) {
    for (const event of [
      undefined,
      { ...admission, newQuestionAdmitted: false },
      { ...admission, logicalQuestionUnitId: "Q0" },
      { ...admission, previousLogicalQuestionUnitId: undefined },
      { ...admission, logicalQuestionUnitId: "" },
    ]) {
      const result = decide({
        projectMainlineAdmission: event,
        currentQuestion: `${operation}: architecture, validation, impact, hardest technical challenge`,
        currentAnswer: "Summary is complete. phase=project_QA",
      });
      assert.equal(result.phase, "project_summary", operation);
      assert.equal(result.action, "stay", operation);
    }
  }
});

test("PS3/PS7: denied response or invalid operation cannot mutate phase", () => {
  for (const deniedByCaller of [
    "no-advise", "informational", "advise-only", "duplicate-operation", "stale-source",
    "superseded-revision", "clear", "stop", "late-generation", "manual-back-base-changed",
  ]) {
    const result = decide({
      projectMainlineAdmission: { ...admission, authorized: false },
      currentQuestion: deniedByCaller,
    });
    assert.equal(result.phase, "project_summary");
    assert.equal(result.reason, "project-phase-admission-not-authorized");
  }
});

test("PS4/PS7: final child, current-only or different parent owners cannot advance P", () => {
  for (const responseOwner of [
    { kind: "child" as const, parentId: "P" },
    { kind: "current-only" as const, parentId: "P" },
    { kind: "parent" as const, parentId: "other-parent" },
    { kind: "parent" as const },
  ]) {
    const result = decide({ projectMainlineAdmission: { ...admission, responseOwner } });
    assert.equal(result.phase, "project_summary");
    assert.equal(result.action, "stay");
  }
  assert.equal(decide({ relation: "child-probe", projectMainlineAdmission: admission }).action, "child-probe");
  assert.equal(decide({ relation: "child-probe", projectMainlineAdmission: admission }).phase, "project_summary");
});

test("PS4/PS5: true new mainline resume may advance; plain restore/merge preserves phase", () => {
  const resumed = decide({ relation: "resume-parent", projectMainlineAdmission: admission });
  assert.equal(resumed.phase, "project_QA");
  assert.equal(resumed.action, "advance");
  for (const currentPhase of ["project_summary", "project_QA"] as const) {
    assert.equal(decide({ relation: "resume-parent", currentPhase }).phase, currentPhase);
    assert.equal(decide({ relation: "followup-parent", currentPhase }).phase, currentPhase);
    assert.equal(decide({ relation: "resume-parent", currentPhase, projectMainlineAdmission: { ...admission, newQuestionAdmitted: false } }).phase, currentPhase);
  }
});

test("PS5: selection completion and repeated binding retain QA; rejected rebind cannot reset it", () => {
  for (const event of [
    undefined,
    { ...admission, newQuestionAdmitted: false },
    { ...admission, initializesSummary: true, authorized: false },
    { ...admission, initializesSummary: true, responseOwner: { kind: "child" as const, parentId: "P" } },
  ]) {
    assert.equal(decide({ currentPhase: "project_QA", projectMainlineAdmission: event }).phase, "project_QA");
  }
});

test("PS6: manual Next has exactly one step, even without a populated progress map", () => {
  const branch = { ownerKind: "parent" as const, questionType: "project-deep-dive" };
  const next = decideManualNextPhaseTransitionForBranch({ ...branch, currentPhase: "project_summary" });
  assert.equal(next.phase, "project_QA");
  assert.equal(next.action, "advance");
  assert.equal(next.source, "manual-next");
  const terminal = decideManualNextPhaseTransitionForBranch({ ...branch, currentPhase: "project_QA" });
  assert.equal(terminal.action, "stay");
  assert.equal(terminal.guardStatus, "blocked-no-next-phase");
  assert.equal(terminal.targetArtifact, "none");
});

test("PS6/PS7: existing history guards late pre-Back receipts, then a later new admission can advance", () => {
  const owner = { kind: "parent" as const, id: "P", parentId: "P" };
  const advanceInput = {
    operationId: "op-Q1", owner,
    fromPhase: "project_summary" as const, toPhase: "project_QA" as const,
    taskRevision: 2, expectedPhaseRevision: 0, committedAt: 1,
  };
  const advanced = appendCommittedAutomaticPhaseTransition(createPlaybookPhaseHistoryState(), advanceInput);
  assert.equal(advanced.status, "appended");
  assert.equal(appendCommittedAutomaticPhaseTransition(advanced.state, advanceInput).status, "duplicate-operation");
  const back = decideManualPlaybookPhaseBack({
    history: advanced.state,
    current: { owner, currentPhase: "project_QA", taskRevision: 2, phaseRevision: 1 },
    request: { operationId: "back", owner, expectedTaskRevision: 2, expectedPhaseRevision: 1, requestedAt: 2 },
  });
  assert.equal(back.status, "ready");
  assert.equal(back.targetPhase, "project_summary");
  const restored = appendCommittedManualBackPhaseTransition(advanced.state, {
    operationId: "back", owner, fromPhase: "project_QA", toPhase: "project_summary",
    taskRevision: 3, expectedPhaseRevision: 1, committedAt: 2,
  });
  assert.equal(restored.status, "appended");
  assert.equal(appendCommittedAutomaticPhaseTransition(restored.state, {
    ...advanceInput, operationId: "late-Q2", expectedPhaseRevision: 1,
  }).status, "stale-phase-revision");
  assert.equal(decide().phase, "project_summary");
  assert.equal(decide({ projectMainlineAdmission: { ...admission, authorized: false } }).phase, "project_summary");
  assert.equal(decide({ projectMainlineAdmission: { ...admission, previousLogicalQuestionUnitId: "Q2", logicalQuestionUnitId: "Q3" } }).phase, "project_QA");
});

test("PS4: Coding child keeps implementation artifacts and no inherited long Summary contract", () => {
  const playbook = createInterviewPlaybookFromCatalog({ questionType: "coding", confidence: 0.9, reason: "child" });
  const child = createCodingChildPhaseState({ questionType: "coding", playbook });
  assert.ok(child);
  const decision = decidePlaybookPhaseProgression({
    questionType: "coding", playbookId: "coding_algorithm", currentPhase: child.phase,
    projectMainlineAdmission: admission,
  });
  assert.equal(decision.phase, "implementation_validation");
  assert.deepEqual(decision.requiredArtifacts, ["answer", "code", "complexity"]);
  const task: ActiveMeetingTask = {
    id: "task", runtimeRevision: 1, source: "voice",
    parent: { id: "P", questionType: "project-deep-dive", topic: "project", playbookPhase: "project_summary",
      phaseProgress: {}, supportedFactAnchors: [], createdAt: 0, updatedAt: 0 },
    child: { id: "C", questionType: "coding", relation: "child-probe", intent: "implementation-probe",
      question: "Implement the parser", basedOnTurnIds: [], basedOnObservationIds: [], createdAt: 0, updatedAt: 0 },
  };
  assert.doesNotMatch(formatPlaybookPhaseDecisionForPrompt(decision, task), /3-5 minute|projectDeepDivePhaseContract/);
  assert.doesNotMatch(formatPlaybookPhaseDecisionForPrompt(undefined, task), /3-5 minute|projectDeepDivePhaseContract/);
});

test("PS8: legacy phases are not accepted as a live PDD phase or prompt fallback", () => {
  // Historical readers retain their raw strings; this is the live boundary.
  for (const legacy of ["project_narrative", "architecture_decision", "validation_reliability", "impact_lessons"]) {
    const phase = legacy as unknown as NonNullable<PlaybookPhaseDecisionInput["currentPhase"]>;
    assert.equal(resolvePlaybookState({ questionType: "project-deep-dive", phase }).phaseCompatible, false);
    assert.equal(decide({ currentPhase: phase }).action, "stay");
    assert.equal(formatProjectDeepDivePhaseContract(phase), "");
  }
});

function buildAdmission(overrides: Partial<ProjectMainlinePhaseAdmissionInput> = {}) {
  return buildProjectMainlinePhaseAdmission({
    logicalQuestionUnit: { id: "Q1", sessionId: "session" },
    effectiveRecords: [{ sessionId: "session", logicalQuestionUnitId: "Q0",
      owner: { kind: "parent-mainline", parentId: "P" } }],
    parentId: "P",
    responseOwner: { kind: "parent", parentId: "P" },
    source: "live-turn",
    authorized: true,
    ...overrides,
  });
}

test("PS2 builder: Voice and Screen share ledger-backed new mainline admission", () => {
  for (const source of ["live-turn", "manual-screen"] as const) {
    const event = buildAdmission({ source });
    assert.deepEqual(event, admission);
    assert.equal(decide({ projectMainlineAdmission: event }).phase, "project_QA");
  }
});

test("PS3 builder: every recorded revision/owner of the same Q suppresses re-admission", () => {
  for (const owner of [
    { kind: "parent-mainline" as const, parentId: "P" },
    { kind: "active-child" as const, parentId: "P", childId: "C" },
    { kind: "parent-mainline" as const, parentId: "other" },
  ]) {
    const stored = { sessionId: "session", logicalQuestionUnitId: "Q1", owner,
      logicalQuestionRevision: 1 };
    const revisedQuestion = { id: "Q1", sessionId: "session", revision: 2 };
    const event = buildAdmission({ logicalQuestionUnit: revisedQuestion, effectiveRecords: [stored] });
    assert.equal(event?.newQuestionAdmitted, false);
    assert.equal(decide({ projectMainlineAdmission: event }).phase, "project_summary");
  }
});

test("PS3 builder: generation retry reads the same admitted ledger identity", () => {
  const input: ProjectMainlinePhaseAdmissionInput = {
    logicalQuestionUnit: { id: "Q1", sessionId: "session" },
    effectiveRecords: [{ sessionId: "session", logicalQuestionUnitId: "Q0",
      owner: { kind: "parent-mainline", parentId: "P" } }],
    parentId: "P", responseOwner: { kind: "parent", parentId: "P" },
    source: "live-turn", authorized: true,
  };
  const before = structuredClone(input);
  assert.equal(buildProjectMainlinePhaseAdmission(input)?.newQuestionAdmitted, true);
  assert.deepEqual(input, before);
  const afterCommit = [...input.effectiveRecords, {
    sessionId: "session", logicalQuestionUnitId: "Q1",
    owner: { kind: "parent-mainline" as const, parentId: "P" },
  }];
  for (const source of ["live-turn", "manual-screen", "regenerate"] as const) {
    assert.equal(buildProjectMainlinePhaseAdmission({ ...input, source, effectiveRecords: afterCommit })?.newQuestionAdmitted, false);
  }
});

test("PS3/PS5 builder: source actions, selection, bind-voice and replay are not new mainline admission", () => {
  for (const source of ["regenerate", "response-action", "artifact-regeneration", "clarifying-answer", "manual-correction", "force-advise"] as const) {
    assert.equal(buildAdmission({ source })?.newQuestionAdmitted, false, source);
  }
  for (const overrides of [
    { replay: true }, { boundVoicePrimaryAsk: true }, { projectSelection: true },
    { freshParentCreated: true }, { initializesSummary: true },
  ]) {
    const event = buildAdmission({ source: "manual-screen", ...overrides });
    assert.equal(event?.newQuestionAdmitted, false);
    assert.equal(decide({ projectMainlineAdmission: event }).phase, "project_summary");
  }
});

test("PS4 builder: final owner is supplied by settlement, never inferred from old ledger projection", () => {
  for (const responseOwner of [
    { kind: "child" as const, parentId: "P" },
    { kind: "current-only" as const, parentId: "P" },
    { kind: "parent" as const, parentId: "other" },
  ]) {
    const event = buildAdmission({ responseOwner });
    assert.deepEqual(event?.responseOwner, responseOwner);
    assert.equal(decide({ projectMainlineAdmission: event }).phase, "project_summary");
  }
  assert.equal(decide({ relation: "resume-parent", projectMainlineAdmission: buildAdmission() }).phase, "project_QA");
});

test("PS6/PS7 builder: original operation-base rejection survives otherwise-new identity", () => {
  const event = buildAdmission({ authorized: false });
  assert.equal(event?.newQuestionAdmitted, true);
  assert.equal(event?.authorized, false);
  assert.equal(decide({ projectMainlineAdmission: event }).phase, "project_summary");
});

test("PS7 builder: missing identity and unrelated session history cannot authorize progression", () => {
  for (const overrides of [{ logicalQuestionUnit: undefined }, { parentId: undefined }]) {
    assert.equal(buildAdmission(overrides), undefined);
  }
  const event = buildAdmission({ effectiveRecords: [
    { sessionId: "old-session", logicalQuestionUnitId: "Q0", owner: { kind: "parent-mainline", parentId: "P" } },
  ] });
  assert.equal(event?.previousLogicalQuestionUnitId, undefined);
  assert.equal(decide({ projectMainlineAdmission: event }).phase, "project_summary");
});
