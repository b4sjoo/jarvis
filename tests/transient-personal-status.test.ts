import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveMeetingTask } from "../src/lib/meeting/active-meeting-task.js";
import { detectPersonalEvidenceRequirement } from "../src/lib/meeting/personal-evidence-guardrail.js";
import {
  formatTransientPersonalStatusForTrace,
  formatTransientPersonalStatusLabel,
  resolveTransientPersonalStatusDecision,
} from "../src/lib/meeting/transient-personal-status.js";

function activeTask(
  questionType: ActiveMeetingTask["parent"]["questionType"] = "coding"
): ActiveMeetingTask {
  return {
    id: "parent-a",
    runtimeRevision: 1,
    source: "voice",
    parent: {
      id: "parent-a",
      questionType,
      topic: "Implement a queue",
      playbookPhase:
        questionType === "coding"
          ? "solution_planning"
          : "requirement_clarification",
      phaseProgress: {},
      supportedFactAnchors: [],
      createdAt: 10,
      updatedAt: 20,
      revisions: 3,
    },
  };
}

const cases = [
  {
    question: "Are you open to relocation?",
    domain: "relocation",
  },
  {
    question: "What are your compensation expectations?",
    domain: "compensation",
  },
  {
    question: "Will you now or in the future require sponsorship?",
    domain: "work-authorization",
  },
  {
    question: "When can you start?",
    domain: "start-date",
  },
] as const;

for (const item of cases) {
  test(`resolves ${item.domain} as a transient personal-status response`, () => {
    const evidence = detectPersonalEvidenceRequirement({
      questionText: item.question,
      questionType: "coding",
      mode: "enforcement",
    });
    const decision = resolveTransientPersonalStatusDecision({
      personalEvidenceDecision: evidence,
      sourceQuestionUnitId: "question-a",
      sourceQuestionRevision: 2,
      activeMeetingTask: activeTask(),
      createdAt: 100,
    });

    assert.equal(decision?.domain, item.domain);
    assert.equal(decision?.responseOwner, "personal-status");
    assert.equal(decision?.evidencePolicy, "profile-only");
    assert.equal(decision?.disposition, "domain-resolved-unknown");
    assert.equal(decision?.preservedParentQuestionType, "coding");
    assert.equal(decision?.preservedPlaybookPhase, "solution_planning");
    assert.equal(Object.isFrozen(decision), true);
    assert.match(
      formatTransientPersonalStatusLabel(item.domain),
      /^Personal Status · /
    );
  });
}

test("keeps unsupported domains out while routing high-confidence shadow logistics", () => {
  const employment = detectPersonalEvidenceRequirement({
    questionText: "Are you currently employed?",
    questionType: "unknown",
    mode: "enforcement",
  });
  const shadowRelocation = detectPersonalEvidenceRequirement({
    questionText: "Are you open to relocation?",
    questionType: "unknown",
    mode: "shadow",
  });

  assert.equal(
    resolveTransientPersonalStatusDecision({
      personalEvidenceDecision: employment,
      sourceQuestionUnitId: "question-a",
      sourceQuestionRevision: 1,
    }),
    undefined
  );
  const shadowDecision = resolveTransientPersonalStatusDecision({
      personalEvidenceDecision: shadowRelocation,
      sourceQuestionUnitId: "question-a",
      sourceQuestionRevision: 1,
    });
  assert.equal(shadowDecision?.domain, "relocation");
  assert.equal(shadowDecision?.responseOwner, "personal-status");
});

test("emits replay-safe trace metadata without copying the question text", () => {
  const evidence = detectPersonalEvidenceRequirement({
    questionText: "Are you open to relocation?",
    questionType: "general-system-design",
    mode: "enforcement",
  });
  const decision = resolveTransientPersonalStatusDecision({
    personalEvidenceDecision: evidence,
    sourceQuestionUnitId: "question-a",
    sourceQuestionRevision: 2,
    activeMeetingTask: activeTask("general-system-design"),
    createdAt: 100,
  });
  const trace = formatTransientPersonalStatusForTrace(decision);

  assert.equal(trace.transientPersonalStatusApplied, true);
  assert.equal(trace.transientPersonalStatusDomain, "relocation");
  assert.equal(
    trace.transientPersonalStatusDisposition,
    "domain-resolved-unknown"
  );
  assert.equal(
    JSON.stringify(trace).includes("Are you open to relocation"),
    false
  );
});
