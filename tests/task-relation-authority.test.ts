import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResponseOnlyTaskScopeToPromptContext,
  createResponseOnlyTaskScope,
  formatBoundedParentReadContextForPrompt,
  resolveResponseOnlyContextReadScope,
} from "../src/lib/meeting/response-only-task-scope.js";
import {
  decideActiveParentTaskRelationAuthority,
  decideCrossTypeTaskRelationAuthority,
  isExplicitResumeParentTranscript,
} from "../src/lib/meeting/task-relation-authority.js";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/types.js";

test("independent coding after system design is response-only without parent binding", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "ai-ml-system-design",
    candidateQuestionType: "coding",
    currentText:
      "Write a Python function that recursively finds all text files.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "child-probe");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("a locally bound coding request remains an authorized child", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "ai-ml-system-design",
    candidateQuestionType: "coding",
    currentText:
      "For this retrieval pipeline, implement the reranking loss.",
  });

  assert.equal(decision?.relation, "child-probe");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
  assert.deepEqual(decision?.evidenceSpans, [
    "For this retrieval pipeline",
  ]);
});

test("an explicit architecture revision remains an authorized design-parent follow-up", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText:
      "try to add surge pricing explain which components need to change",
  });

  assert.equal(decision?.relation, "followup-parent");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
  assert.equal(decision?.reason, "explicit-design-parent-revision");
  assert.equal(decision?.evidenceSpans.length, 2);
  assert.match(decision?.evidenceSpans[0] ?? "", /surge pricing/);
  assert.equal(
    decision?.evidenceSpans[1],
    "which components need to change"
  );
});

test("an explicit task switch authorizes a new parent relation", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "coding",
    currentText:
      "Now let's move to a separate coding question.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "new-parent");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
});

test("an explicit same-type task switch authorizes a new parent", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "coding",
    candidateQuestionType: "coding",
    currentText: "Next, let's move to a separate coding problem.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "new-parent");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
});

test("an explicit request for another owned project starts a new project parent", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "project-deep-dive",
    candidateQuestionType: "project-deep-dive",
    currentText:
      "Can you tell me about another backend system or service you've owned where consistency was critical?",
  });

  assert.equal(decision?.relation, "new-parent");
  assert.equal(decision?.disposition, "authorized");
  assert.equal(decision?.relationEvidenceAuthorized, true);
  assert.equal(decision?.reason, "explicit-project-switch");
  assert.match(decision?.evidenceSpans[0] ?? "", /another backend system/i);
});

test("another component inside the same design does not create a project parent", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "project-deep-dive",
    candidateQuestionType: "project-deep-dive",
    currentText:
      "How would another cache service fit inside this same project?",
  });

  assert.equal(decision, undefined);
});

test("an explicit switch to a non-parent type uses response-only scope", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText: "Next, let's move to a separate question about HNSW.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, true);
});

test("cross-type parent classification alone cannot create a new parent", () => {
  const decision = decideCrossTypeTaskRelationAuthority({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "ai-ml-system-design",
    currentText: "Design a self-evolving recommendation agent.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("ordinary active-parent text remains response-only", () => {
  const decision = decideActiveParentTaskRelationAuthority({
    hasLatestUsefulText: true,
    hasActiveChild: false,
    explicitResume: false,
    correction: false,
    logistics: false,
    broadResumeProposal: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "followup-parent");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("broad similarity cannot resume an active parent from a child", () => {
  const decision = decideActiveParentTaskRelationAuthority({
    hasLatestUsefulText: true,
    hasActiveChild: true,
    explicitResume: false,
    correction: false,
    logistics: false,
    broadResumeProposal: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "resume-parent");
  assert.equal(decision?.disposition, "response-only");
  assert.equal(decision?.reason, "broad-resume-proposal-nonauthoritative");
});

test("explicit resume and correction retain relation authority", () => {
  const resume = decideActiveParentTaskRelationAuthority({
    hasLatestUsefulText: true,
    hasActiveChild: true,
    explicitResume: true,
    correction: false,
    logistics: false,
    broadResumeProposal: false,
  });
  const correction = decideActiveParentTaskRelationAuthority({
    hasLatestUsefulText: true,
    hasActiveChild: false,
    explicitResume: false,
    correction: true,
    logistics: false,
    broadResumeProposal: false,
  });

  assert.equal(resume?.relation, "resume-parent");
  assert.equal(resume?.relationEvidenceAuthorized, true);
  assert.equal(correction?.relation, "correction");
  assert.equal(correction?.relationEvidenceAuthorized, true);
});

test("explicit resume detection uses the source-owned transition wording", () => {
  assert.equal(
    isExplicitResumeParentTranscript(
      "Let's return to the main ride-sharing design and discuss observability."
    ),
    true
  );
  assert.equal(
    isExplicitResumeParentTranscript("What metrics would you use?"),
    false
  );
});

test("response-only current scope excludes generated continuity but retains read-only parent identity", () => {
  const activeMeetingTask = task();
  const scope = createResponseOnlyTaskScope({
    logicalQuestionUnitId: "question-new",
    revision: 2,
    sourceQuestion: "Explain HNSW.",
    sourceTurnIds: ["turn-new"],
    inferredType: "field-knowledge",
    relationDisposition: "ambiguous",
    preservedParent: activeMeetingTask,
    now: 100,
  });
  const context: AdvisorPromptContext = {
    transcript: "Them: Design a vector database.\nThem: Explain HNSW.",
    advisorPromptSourceTurnIds: ["turn-parent", "turn-new"],
    screenContext: "parent whiteboard",
    interviewSessionBrief: {
      targetCompany: "Example",
      companyLocked: true,
      interviewTypes: ["mixed"],
    },
    activeMeetingTask,
    taskRuntime: {
      revision: 1,
      parent: {
        id: activeMeetingTask.parent.id,
        source: "voice",
        stableKind: "ai-ml-system-design",
        topic: activeMeetingTask.parent.topic,
        playbookPhase: "design_framing",
        phaseProgress: {},
        supportedFactAnchors: ["project-a"],
        createdAt: 1,
        updatedAt: 2,
        revisions: 3,
      },
    },
    rollingSummary: "parent summary",
    userProfileContext: "private parent facts",
    glossaryText: "HNSW",
    confirmedMeFacts: [{ id: "fact-a", text: "parent fact" }],
  };

  const scoped = applyResponseOnlyTaskScopeToPromptContext(
    context,
    scope
  );

  assert.equal(scoped.transcript, "Them: Explain HNSW.");
  assert.deepEqual(scoped.advisorPromptSourceTurnIds, ["turn-new"]);
  assert.equal(scoped.activeMeetingTask, undefined);
  assert.equal(scoped.taskRuntime.parent, undefined);
  assert.equal(scoped.screenContext, "");
  assert.equal(scoped.rollingSummary, "");
  assert.equal(scoped.userProfileContext, "");
  assert.equal(scoped.interviewSessionBrief?.targetCompany, "Example");
  assert.deepEqual(scoped.interviewSessionBrief?.interviewTypes, ["mixed"]);
  assert.equal(scoped.confirmedMeFacts, undefined);
  assert.equal(scope.preservedParentId, activeMeetingTask.parent.id);
  assert.equal(
    scope.readOnlyParentContinuity?.parentId,
    activeMeetingTask.parent.id
  );
  assert.equal(
    scope.readOnlyParentContinuity?.questionType,
    "ai-ml-system-design"
  );
  assert.equal(
    scope.readOnlyParentContinuity?.playbookPhase,
    "design_framing"
  );
  assert.equal(
    scope.readOnlyParentContinuity?.compatibleWithInferredType,
    false
  );
  assert.equal(scope.contextReadScope, "current-only");
  assert.equal(scope.artifactMutation, "none");
  assert.equal(scope.taskMutation, "none");
});

test("response-only follow-up reads a bounded source-owned parent capsule", () => {
  const activeMeetingTask = task();
  activeMeetingTask.parent.canonicalQuestionSourceTurnIds = [
    "turn-parent",
  ];
  activeMeetingTask.parent.latestUsefulAnswer =
    "Generated architecture answer that must stay excluded.";
  activeMeetingTask.parent.whiteboardArtifact = {
    id: "whiteboard-a",
    parentTaskId: activeMeetingTask.parent.id,
    domainTrack: "ml_sd",
    currentPhase: "design_framing",
    title: "Private generated diagram",
    content: "graph TD; Secret --> Generated",
    summary: "Generated summary",
    revision: 1,
    archetypeIds: [],
    selectedOverlayIds: [],
    updateSource: "model-output",
    updatedAt: 1,
    createdAt: 1,
  };
  activeMeetingTask.parent.parentContextHandoff = {
    sourceParentId: "task-earlier",
    transitionKind: "domain-extension",
    sourceQuestionId: "question-parent",
    sharedScenarioContext: {
      domainEntities: ["documents", "embeddings"],
      sharedRequirements: [
        "The system must support data residency. [source=turn-constraint]",
      ],
      applicableScaleAssumptions: [
        {
          value: "Ten million daily active users.",
          sourceTurnId: "turn-scale",
        },
      ],
    },
    excludedContextKinds: [],
  };
  const contextReadScope = resolveResponseOnlyContextReadScope({
    preservedParent: activeMeetingTask,
    proposedRelation: "followup-parent",
  });
  const scope = createResponseOnlyTaskScope({
    logicalQuestionUnitId: "question-followup",
    revision: 1,
    sourceQuestion: "How would you shard the vector index?",
    sourceTurnIds: ["turn-followup"],
    inferredType: "ai-ml-system-design",
    relationDisposition: "ambiguous",
    preservedParent: activeMeetingTask,
    contextReadScope,
    now: 200,
  });
  const scoped = applyResponseOnlyTaskScopeToPromptContext(
    {
      transcript: "full transcript",
      screenContext: "generated screen context",
      activeMeetingTask,
      rollingSummary: "generated summary",
      userProfileContext: "profile",
      glossaryText: "HNSW",
      taskRuntime: { revision: 0 },
    },
    scope
  );
  const formatted = formatBoundedParentReadContextForPrompt(
    scoped.responseOnlyParentReadContext
  );

  assert.equal(contextReadScope, "active-parent-read");
  assert.equal(
    scoped.responseOnlyParentReadContext?.objective,
    "Design a vector database"
  );
  assert.deepEqual(scoped.advisorPromptSourceTurnIds, [
    "turn-parent",
    "turn-scale",
    "turn-followup",
  ]);
  assert.match(formatted, /data residency/);
  assert.match(formatted, /documents, embeddings/);
  assert.doesNotMatch(formatted, /Generated architecture answer/);
  assert.doesNotMatch(formatted, /Secret/);
  assert.equal(scoped.activeMeetingTask, undefined);
  assert.equal(scoped.memoryContext, undefined);
});

test("response-only independent task proposals cannot read the parent", () => {
  const contextReadScope = resolveResponseOnlyContextReadScope({
    preservedParent: task(),
    proposedRelation: "new-parent",
  });
  const scope = createResponseOnlyTaskScope({
    logicalQuestionUnitId: "question-independent",
    revision: 1,
    sourceQuestion: "Implement a standalone stack.",
    inferredType: "coding",
    relationDisposition: "ambiguous",
    preservedParent: task(),
    contextReadScope,
    now: 300,
  });

  assert.equal(contextReadScope, "current-only");
  assert.equal(scope.parentReadContext, undefined);
  assert.equal(scope.readOnlyParentContinuity?.parentId, "task-parent");
  assert.equal(
    scope.readOnlyParentContinuity?.compatibleWithInferredType,
    false
  );
});

test("bounded recent history keeps only the source-owned parent read capsule", () => {
  const activeMeetingTask = task();
  const scope = createResponseOnlyTaskScope({
    logicalQuestionUnitId: "question-deictic",
    revision: 2,
    sourceQuestion: "Can you explain that trade-off?",
    sourceTurnIds: ["turn-deictic"],
    inferredType: "ai-ml-system-design",
    relationDisposition: "ambiguous",
    preservedParent: activeMeetingTask,
    contextReadScope: "bounded-recent-history",
    now: 400,
  });
  const scoped = applyResponseOnlyTaskScopeToPromptContext(
    {
      transcript: "full transcript",
      screenContext: "",
      activeMeetingTask,
      rollingSummary: "generated summary",
      userProfileContext: "profile",
      glossaryText: "",
      taskRuntime: { revision: 0 },
    },
    scope
  );

  assert.equal(scope.contextReadScope, "bounded-recent-history");
  assert.equal(scope.parentReadContext?.parentId, "task-parent");
  assert.equal(
    scoped.responseOnlyParentReadContext?.objective,
    "Design a vector database"
  );
  assert.equal(scoped.activeMeetingTask, undefined);
  assert.equal(scoped.rollingSummary, "");
});

function task(): ActiveMeetingTask {
  return {
    id: "task-parent",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "task-parent",
      questionType: "ai-ml-system-design",
      topic: "Design a vector database",
      playbookPhase: "design_framing",
      phaseProgress: {},
      supportedFactAnchors: ["project-a"],
      createdAt: 1,
      updatedAt: 2,
      revisions: 3,
    },
  };
}
