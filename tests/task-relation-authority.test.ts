import type { ActiveMeetingTask } from "../src/lib/meeting/meeting-task-contracts.js";
import type { AdvisorPromptContext } from "../src/lib/meeting/meeting-context-contracts.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  projectActiveParentTaskRelationHint,
  projectCrossTypeTaskRelationHint,
  isExplicitResumeParentTranscript,
} from "../src/lib/meeting/task-relation-authority.js";


const meetingHookSource = await readFile(
  path.join(process.cwd(), "src/hooks/useMeetingAssistant.ts"),
  "utf8"
);

test("independent coding after system design remains a non-authoritative hint", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "ai-ml-system-design",
    candidateQuestionType: "coding",
    currentText:
      "Write a Python function that recursively finds all text files.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "child-probe");
  assert.equal(decision?.relationEvidenceAuthorized, false);
  assert.equal("disposition" in (decision ?? {}), false);
});

test("live advisor signals never convert a lexical hint into response-only", () => {
  assert.doesNotMatch(
    meetingHookSource,
    /taskRelationLexicalHint\?\.disposition/
  );
  assert.doesNotMatch(
    meetingHookSource,
    /response-only-ambiguous-relation/
  );
  assert.doesNotMatch(
    meetingHookSource,
    /ordered-chain-error-response-only/
  );
});

test("a locally bound coding request remains a child hint", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "ai-ml-system-design",
    candidateQuestionType: "coding",
    currentText:
      "For this retrieval pipeline, implement the reranking loss.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "child-probe");
  assert.equal(decision?.relationEvidenceAuthorized, false);
  assert.deepEqual(decision?.evidenceSpans, [
    "For this retrieval pipeline",
  ]);
});

test("an explicit architecture revision remains a design-parent hint", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText:
      "try to add surge pricing explain which components need to change",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "followup-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
  assert.equal(decision?.reason, "explicit-design-parent-revision-hint");
  assert.equal(decision?.evidenceSpans.length, 2);
  assert.match(decision?.evidenceSpans[0] ?? "", /surge pricing/);
  assert.equal(
    decision?.evidenceSpans[1],
    "which components need to change"
  );
});

test("an explicit task switch is evidence only and cannot mutate the parent", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "coding",
    currentText:
      "Now let's move to a separate coding question.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("an explicit same-type task switch still requires semantic settlement", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "coding",
    candidateQuestionType: "coding",
    currentText: "Next, let's move to a separate coding problem.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("an explicit request for another owned project is strong evidence only", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "project-deep-dive",
    candidateQuestionType: "project-deep-dive",
    currentText:
      "Can you tell me about another backend system or service you've owned where consistency was critical?",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
  assert.equal(decision?.reason, "explicit-project-switch-evidence-only");
  assert.match(decision?.evidenceSpans[0] ?? "", /another backend system/i);
});

test("another component inside the same design does not create a project parent", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "project-deep-dive",
    candidateQuestionType: "project-deep-dive",
    currentText:
      "How would another cache service fit inside this same project?",
  });

  assert.equal(decision, undefined);
});

test("an explicit switch to a non-parent type remains hint-only", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "field-knowledge",
    currentText: "Next, let's move to a separate question about HNSW.",
    explicitTaskSwitch: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("cross-type parent classification alone cannot create a new parent", () => {
  const decision = projectCrossTypeTaskRelationHint({
    activeQuestionType: "general-system-design",
    candidateQuestionType: "ai-ml-system-design",
    currentText: "Design a self-evolving recommendation agent.",
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "new-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("ordinary active-parent text remains a non-authoritative hint", () => {
  const decision = projectActiveParentTaskRelationHint({
    hasLatestUsefulText: true,
    hasActiveChild: false,
    explicitResume: false,
    broadResumeProposal: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "followup-parent");
  assert.equal(decision?.relationEvidenceAuthorized, false);
});

test("broad similarity cannot resume an active parent from a child", () => {
  const decision = projectActiveParentTaskRelationHint({
    hasLatestUsefulText: true,
    hasActiveChild: true,
    explicitResume: false,
    broadResumeProposal: true,
  });

  assert.equal(decision?.relation, "unknown");
  assert.equal(decision?.proposedRelation, "resume-parent");
  assert.equal(decision?.reason, "broad-resume-proposal-nonauthoritative");
});

test("an explicit parent resume remains a non-authoritative hint", () => {
  const resume = projectActiveParentTaskRelationHint({
    hasLatestUsefulText: true,
    hasActiveChild: true,
    explicitResume: true,
    broadResumeProposal: false,
  });

  assert.equal(resume?.relation, "unknown");
  assert.equal(resume?.proposedRelation, "resume-parent");
  assert.equal(resume?.relationEvidenceAuthorized, false);
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
  assert.equal(isExplicitResumeParentTranscript("Continue."), false);
  assert.equal(
    isExplicitResumeParentTranscript("How would you evaluate it?"),
    false
  );
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
