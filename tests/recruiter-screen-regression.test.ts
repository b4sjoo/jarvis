import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeMemoryRoleTelemetry } from "../src/lib/memory/runtime-role.js";
import type {
  MemoryEntry,
  MemoryRetrievalResult,
  RetrievedMemoryEntry,
} from "../src/lib/memory/types.js";
import {
  buildFactAnchorDecision,
  formatFactAnchorDecisionForTrace,
} from "../src/lib/meeting/fact-anchor-guardrail.js";
import {
  buildMeetingAnswerSummary,
  formatMeetingAnswerTraceMetadata,
  parseMeetingAnswer,
} from "../src/lib/meeting/meeting-answer.js";
import {
  formatProjectBindingDecisionForTrace,
  resolveProjectBinding,
} from "../src/lib/meeting/project-binding.js";
import { inferQuestionTypeDecisionFromText } from "../src/lib/meeting/task-taxonomy.js";
import { validateTranscriptCandidate } from "../src/lib/meeting/transcript-validation.js";
import type {
  InterviewTaskRelation,
  ProjectBinding,
} from "../src/lib/meeting/types.js";
import {
  RECORDED_RECRUITER_SPEECH_BIAS_PROMPT,
  RECRUITER_SCREEN_REGRESSION_FIXTURE,
  type RecruiterRegressionTurnFixture,
} from "./fixtures/recruiter-screen-session.js";

interface RecruiterScenarioTurnResult {
  id: string;
  disposition: RecruiterRegressionTurnFixture["expectedDisposition"];
  questionType?: string;
  relation?: InterviewTaskRelation;
  modelRoute?: "main" | "coding-override";
  parentId?: string;
  binding?: ProjectBinding;
  advisorCalled: boolean;
  trace: Record<string, unknown>;
}

test("replays the sanitized recruiter failure chain through runtime decisions", () => {
  const fixture = RECRUITER_SCREEN_REGRESSION_FIXTURE;
  const memoryContext = makeMemoryResult();
  const results: RecruiterScenarioTurnResult[] = [];
  let parentId: string | undefined;
  let binding: ProjectBinding | undefined;

  for (const turn of fixture.turns) {
    const before = { parentId, binding };
    const validation = validateTranscriptCandidate({
      text: turn.text,
      speechBiasPrompt: RECORDED_RECRUITER_SPEECH_BIAS_PROMPT,
      startedAt: 1_000,
      endedAt: 2_000,
    });
    const transcriptTrace = {
      transcriptDisposition: validation.disposition,
      sttValidationDisposition: validation.disposition,
      sttValidationReason: validation.reason,
    };

    if (turn.expectedDisposition === "rejected") {
      assert.equal(validation.disposition, "rejected", turn.id);
      results.push({
        id: turn.id,
        disposition: "rejected",
        parentId,
        binding,
        advisorCalled: false,
        trace: transcriptTrace,
      });
      assert.deepEqual({ parentId, binding }, before, `${turn.id}: state mutated`);
      continue;
    }

    assert.equal(validation.disposition, "accepted", turn.id);

    if (turn.expectedDisposition === "append-only") {
      results.push({
        id: turn.id,
        disposition: "append-only",
        relation: "logistics",
        parentId,
        binding,
        advisorCalled: false,
        trace: { ...transcriptTrace, taskRelation: "logistics" },
      });
      assert.deepEqual({ parentId, binding }, before, `${turn.id}: state mutated`);
      continue;
    }

    const inference = inferQuestionTypeDecisionFromText(turn.text);
    assert.equal(inference.type, turn.expectedQuestionType, `${turn.id}: type`);
    const relation: InterviewTaskRelation = parentId
      ? "followup-parent"
      : "new-parent";
    assert.equal(relation, turn.expectedRelation, `${turn.id}: relation`);

    const bindingDecision = resolveProjectBinding({
      existingBinding: binding,
      questionType: inference.type,
      relation,
      projectAnchor: fixture.project.name,
      memoryContext,
      now: 100,
    });
    assert.notEqual(bindingDecision.action, "needs-selection", `${turn.id}: binding`);
    binding = bindingDecision.binding;
    parentId ??= fixture.parentId;

    const factAnchorDecision = buildFactAnchorDecision({
      questionType: inference.type,
      questionText: turn.text,
      personalEvidenceGuardrailMode: "enforcement",
      memoryContext,
      projectBindingDecision: bindingDecision,
    });
    assert.equal(factAnchorDecision.state, "strong-anchor", `${turn.id}: anchor`);
    assert.equal(
      factAnchorDecision.selectedAnchorId,
      fixture.project.evidenceEntryId,
      `${turn.id}: selected evidence`
    );

    const parsed = parseMeetingAnswer(turn.answerOutput ?? "", {
      expectedProfile: "compact-spoken",
      now: 200,
    });
    const summary = buildMeetingAnswerSummary(parsed);
    assert.equal(parsed.primaryAnswerSource, "reply-alias", `${turn.id}: parser`);
    assert.ok(summary.chars > 0, `${turn.id}: continuity summary`);

    const memoryRoles = buildRuntimeMemoryRoleTelemetry(memoryContext.entries);
    const modelRoute: "main" | "coding-override" =
      String(inference.type) === "coding" ? "coding-override" : "main";
    assert.equal(modelRoute, turn.expectedModelRoute, `${turn.id}: model route`);

    results.push({
      id: turn.id,
      disposition: "advisor",
      questionType: inference.type,
      relation,
      modelRoute,
      parentId,
      binding,
      advisorCalled: true,
      trace: {
        ...transcriptTrace,
        questionTypeInferenceType: inference.type,
        questionTypeConfidence: inference.confidence,
        questionTypeDecisionSource: inference.source,
        questionTypeEvidence: inference.evidence,
        taskRelation: relation,
        activeMeetingParentId: parentId,
        memoryRoleCounts: memoryRoles.counts,
        memoryRoleEntries: memoryRoles.entries,
        ...formatProjectBindingDecisionForTrace(bindingDecision),
        ...formatFactAnchorDecisionForTrace(factAnchorDecision),
        ...formatMeetingAnswerTraceMetadata(parsed, summary),
      },
    });
  }

  const projectResults = results.filter(
    (result) => result.disposition === "advisor"
  );
  assert.equal(projectResults.length, 5);
  assert.deepEqual(
    new Set(projectResults.map((result) => result.parentId)),
    new Set([fixture.parentId])
  );
  assert.deepEqual(
    new Set(projectResults.map((result) => result.binding?.projectId)),
    new Set([fixture.project.id])
  );
  assert.ok(projectResults.every((result) => result.modelRoute === "main"));

  for (const result of projectResults) {
    assertTraceFields(result, [
      "transcriptDisposition",
      "questionTypeInferenceType",
      "questionTypeConfidence",
      "questionTypeDecisionSource",
      "questionTypeEvidence",
      "taskRelation",
      "activeMeetingParentId",
      "projectBindingAction",
      "projectBindingProjectId",
      "memoryRoleCounts",
      "factAnchorState",
      "factAnchorSelectedId",
      "answerContractVersion",
      "answerParseStatus",
      "latestUsefulAnswerChars",
    ]);
  }

  const echoResult = results.find(
    (result) => result.id === "speech-bias-prompt-echo"
  );
  assert.equal(echoResult?.advisorCalled, false);
  assert.equal(echoResult?.trace.sttValidationReason, "prompt-echo-exact");

  const closingResult = results.find(
    (result) => result.id === "closing-logistics"
  );
  assert.equal(closingResult?.advisorCalled, false);
  assert.equal(closingResult?.parentId, fixture.parentId);
  assert.equal(closingResult?.binding?.projectId, fixture.project.id);
});

test("keeps recruiter guidance and interviewer options out of fact evidence", () => {
  const memoryContext = makeMemoryResult();
  const roles = buildRuntimeMemoryRoleTelemetry(memoryContext.entries);
  const guidance = roles.entries.find(
    (entry) => entry.entryId === "mem_testing_guidance"
  );
  const template = roles.entries.find(
    (entry) => entry.entryId === "mem_recruiter_answer_template"
  );

  assert.equal(guidance?.role, "guidance");
  assert.equal(guidance?.anchorEligible, false);
  assert.equal(template?.role, "template");
  assert.equal(template?.anchorEligible, false);

  const bindingDecision = resolveProjectBinding({
    questionType: "project-deep-dive",
    relation: "new-parent",
    projectAnchor: RECRUITER_SCREEN_REGRESSION_FIXTURE.project.name,
    memoryContext,
    now: 100,
  });
  const factAnchor = buildFactAnchorDecision({
    questionType: "project-deep-dive",
    questionText: RECRUITER_SCREEN_REGRESSION_FIXTURE.turns[3].text,
    memoryContext,
    projectBindingDecision: bindingDecision,
  });

  assert.deepEqual(factAnchor.supportedAnchorIds, [
    RECRUITER_SCREEN_REGRESSION_FIXTURE.project.evidenceEntryId,
  ]);
  assert.ok(
    !factAnchor.supportedAnchorIds.map(String).includes("mem_testing_guidance")
  );
  assert.doesNotMatch(
    factAnchor.supportedAnchorTitles.join(" "),
    /load testing|canary|automated/i
  );
});

test("the corpus is sensitive to the historical coding misclassification", () => {
  const historicalFailures = RECRUITER_SCREEN_REGRESSION_FIXTURE.turns.filter(
    (turn) => turn.legacyObservedQuestionType === "coding"
  );
  assert.equal(historicalFailures.length, 4);

  for (const turn of historicalFailures) {
    const current = inferQuestionTypeDecisionFromText(turn.text);
    assert.equal(current.type, "project-deep-dive", turn.id);
    assert.notEqual(current.type, turn.legacyObservedQuestionType, turn.id);
  }
});

function assertTraceFields(
  result: RecruiterScenarioTurnResult,
  keys: string[]
) {
  for (const key of keys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(result.trace, key),
      `${result.id}: missing trace field ${key}`
    );
  }
}

function makeMemoryResult(): MemoryRetrievalResult {
  const entries = RECRUITER_SCREEN_REGRESSION_FIXTURE.memoryEntries.map(
    (spec, index) => makeRetrievedMemoryEntry(spec, 100 - index)
  );
  return {
    entries,
    contextText: entries.map((entry) => entry.injectedContent).join("\n"),
    totalChars: entries.reduce(
      (total, entry) => total + entry.injectedContent.length,
      0
    ),
    candidateCount: entries.length,
    eligibleCount: entries.length,
    rejectedCount: 0,
    rejectSummary: [],
    policySnapshot: {
      useCase: "project_deep_dive",
      maxEntries: 6,
      maxChars: 6000,
      perEntryMaxChars: 1200,
    },
  };
}

function makeRetrievedMemoryEntry(
  spec: (typeof RECRUITER_SCREEN_REGRESSION_FIXTURE.memoryEntries)[number],
  score: number
): RetrievedMemoryEntry {
  const entry: MemoryEntry = {
    id: spec.id,
    sourceIds: [],
    type: spec.type,
    title: spec.title,
    content: spec.content,
    scope: "project",
    projectId: "projectId" in spec ? spec.projectId : undefined,
    projectName: "projectName" in spec ? spec.projectName : undefined,
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["project_deep_dive"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    entry,
    score,
    matchReason: [],
    injectedContent: entry.content,
  };
}
